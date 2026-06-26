// ════════════════════════════════════════════════════════════════════════════
// collab_service.cpp  —  iteration 7
//
// Bug fixes: [BUG-3] [BUG-6] [BUG-7] [BUG-9]
// ════════════════════════════════════════════════════════════════════════════

#include "collab_service.hpp"
#include "analytics.hpp"
#include "role_mask.hpp"

#include <algorithm>
#include <unordered_set>
#include <variant>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/deadline.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

CollabService::CollabService(const components::ComponentConfig&  config,
                              const components::ComponentContext& context)
    : ComponentBase(config, context),
      repo_(context.FindComponent<ArtistRepository>()),
      gateway_(context.FindComponent<GeniusGateway>()),
      worker_(context.FindComponent<EnrichmentWorker>()),
      path_max_expand_rounds_(
          config["path-max-expand-rounds"].As<int>(3))
{}

yaml_config::Schema CollabService::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(R"(
type: object
description: Orchestration layer — graph and path assembly
additionalProperties: false
properties:
    path-max-expand-rounds:
        type: integer
        description: Maximum BFS expansion rounds for FindPath
        defaultDescription: '3'
)");
}

std::optional<ArtistRef> CollabService::ResolveById(std::int64_t id) const {
    if (auto ref = repo_.Lookup(id)) return ref;
    return gateway_.FetchArtistById(id, Lane::Foreground);
}

std::variant<ArtistRef, AmbiguousResult>
CollabService::ResolveByName(const std::string& query) const {
    const auto candidates = gateway_.ResolveCandidates(query);
    if (candidates.empty()) {
        AmbiguousResult ar; ar.query = query; return ar;
    }
    const auto& best = candidates.front();
    if (best.score < gateway_.MatchThreshold()) {
        AmbiguousResult ar;
        ar.query = query;
        const std::size_t limit = std::min<std::size_t>(candidates.size(), 6);
        ar.candidates.assign(candidates.begin(),
                             candidates.begin() +
                             static_cast<std::ptrdiff_t>(limit));
        return ar;
    }
    return ArtistRef{best.id, best.name, best.image, best.url};
}

ArtistSongs CollabService::FetchFg(const ArtistRef& ref) const {
    const int limit = gateway_.SongsLimitFg();
    const auto song_ids = gateway_.FetchSongList(ref.id, limit, Lane::Foreground);

    struct Pending {
        std::int64_t id;
        engine::TaskWithResult<std::optional<SongRecord>> task;
    };
    std::vector<Pending> pending;
    pending.reserve(song_ids.size());
    for (const auto sid : song_ids) {
        pending.push_back({sid, utils::Async(
            "fg-song-detail",
            [this, sid] {
                return gateway_.FetchSongDetail(sid, Lane::Foreground);
            }
        )});
    }

    ArtistSongs out;
    out.seed = ref;
    out.songs.reserve(pending.size());
    for (auto& p : pending) {
        try {
            if (auto rec = p.task.Get()) out.songs.push_back(std::move(*rec));
        } catch (const std::exception& ex) {
            LOG_WARNING() << "[Service] FG song detail " << p.id
                          << ": " << ex.what();
        }
    }
    repo_.WriteThrough(out, Depth::Foreground);
    return out;
}

ArtistSongs CollabService::BuildRadialGraph(const ArtistRef& seed) const {
    auto result = repo_.GetArtistSongs(seed, Depth::Foreground);

    if (result.network_needed) {
        try {
            result.data         = FetchFg(seed);
            result.have         = Depth::Foreground;
            result.network_needed = false;
        } catch (const GeniusHttpError& e) {
            if (e.status_code == 503) {
                LOG_WARNING() << "[Service] CB open for seed=" << seed.id
                              << ", serving from L1 fallback";
            } else {
                throw;
            }
        }
    }
    worker_.EnqueueIfNeeded(seed);
    return std::move(result.data);
}

void CollabService::AppendAdjFromL1(
    const std::unordered_set<std::int64_t>& new_ids,
    const RoleMask&                          mask,
    AdjList&                                 adj,
    std::unordered_map<std::int64_t, ArtistRef>& node_info) const
{
    for (const auto id : new_ids) {
        if (!node_info.count(id)) {
            if (auto ref = repo_.Lookup(id)) node_info[id] = std::move(*ref);
        }

        const auto neighbours = repo_.Neighbours(id, mask);
        for (const auto& edge : neighbours) {
            const std::int64_t nid = edge.neighbour;
            adj[id].push_back(edge);
            adj[nid].push_back({id, edge.weight});

            if (!node_info.count(nid)) {
                if (auto ref = repo_.Lookup(nid)) node_info[nid] = std::move(*ref);
            }
        }
    }
}

PathContext CollabService::FindPath(const ArtistRef&   from,
                                     const ArtistRef&   to,
                                     const RoleMask&    mask,
                                     engine::Deadline   deadline) const
{
    {
        auto rf = repo_.GetArtistSongs(from, Depth::Foreground);
        if (rf.network_needed) { try { FetchFg(from); } catch (...) {} }
    }
    {
        auto rt = repo_.GetArtistSongs(to, Depth::Foreground);
        if (rt.network_needed) { try { FetchFg(to); } catch (...) {} }
    }

    std::unordered_set<std::int64_t> known_ids{from.id, to.id};

    const auto pre_warm = [&](std::int64_t id) {
        for (const auto& edge : repo_.Neighbours(id, mask)) {
            const std::int64_t nid = edge.neighbour;
            if (repo_.GetFetchDepth(nid) >= Depth::Foreground)
                known_ids.insert(nid);
        }
    };
    pre_warm(from.id);
    pre_warm(to.id);

    AdjList adj;
    std::unordered_map<std::int64_t, ArtistRef> node_info;
    std::unordered_map<std::int64_t,
        std::unordered_map<std::int64_t,
            std::unordered_set<std::string>>> edge_songs_dedup;

    std::unordered_set<std::int64_t> processed_ids;

    const auto append_delta = [&]() {
        std::unordered_set<std::int64_t> delta;
        for (const auto id : known_ids)
            if (!processed_ids.count(id)) delta.insert(id);
        AppendAdjFromL1(delta, mask, adj, node_info);
        processed_ids.insert(delta.begin(), delta.end());
    };

    append_delta();

    for (int round = 0; round <= path_max_expand_rounds_; ++round) {
        if (deadline.IsReached()) {
            LOG_WARNING() << "[Service] FindPath deadline exceeded at round "
                          << round << ", delegating frontier to BG";
            for (const auto& [nid, edges] : adj) {
                if (!known_ids.count(nid)) {
                    ArtistRef fref;
                    fref.id = nid;
                    if (const auto it = node_info.find(nid); it != node_info.end())
                        fref = it->second;
                    worker_.EnqueueIfNeeded(fref);
                }
            }
            return PathContext{};
        }

        const auto path = BidirectionalBfs(adj, from.id, to.id);
        if (!path.empty()) {
            LOG_INFO() << "[Service] path found: "
                       << (path.size() - 1) << " hops, "
                       << round << " round(s)";

            std::unordered_map<std::int64_t,
                std::unordered_map<std::int64_t,
                    std::vector<std::string>>> edge_songs_out;
            for (const auto& [lo, hi_map] : edge_songs_dedup)
                for (const auto& [hi, title_set] : hi_map)
                    edge_songs_out[lo][hi].assign(
                        title_set.begin(), title_set.end());

            return PathContext{path, adj,
                               std::move(node_info),
                               std::move(edge_songs_out)};
        }

        if (round == path_max_expand_rounds_) break;

        std::vector<ArtistRef> frontier;
        for (const auto& [nid, edges] : adj) {
            if (known_ids.count(nid)) continue;
            if (repo_.GetFetchDepth(nid) >= Depth::Foreground) {
                known_ids.insert(nid);
                continue;
            }
            ArtistRef fref;
            fref.id = nid;
            if (const auto it = node_info.find(nid); it != node_info.end())
                fref = it->second;
            frontier.push_back(std::move(fref));
        }

        if (frontier.empty()) {
            LOG_INFO() << "[Service] graph saturated after " << round << " round(s)";
            break;
        }

        LOG_INFO() << "[Service] round " << round
                   << ": expanding " << frontier.size() << " frontier node(s)";

        struct ExpandTask {
            ArtistRef ref;
            engine::TaskWithResult<void> task;
        };
        std::vector<ExpandTask> tasks;
        tasks.reserve(frontier.size());
        for (auto& fref : frontier) {
            tasks.push_back({fref, utils::Async(
                "path-expand",
                [this, fref] {
                    try { FetchFg(fref); } catch (const std::exception& ex) {
                        LOG_WARNING() << "[Service] expand " << fref.id
                                      << ": " << ex.what();
                    }
                }
            )});
        }
        for (auto& et : tasks) {
            try { et.task.Get(); } catch (const std::exception& ex) {
                LOG_WARNING() << "[Service] expand task " << et.ref.id
                              << ": " << ex.what();
            }
            known_ids.insert(et.ref.id);
            worker_.EnqueueIfNeeded(et.ref);
        }

        append_delta();
    }

    LOG_INFO() << "[Service] no path found between "
               << from.id << " and " << to.id;
    return PathContext{};
}

} // namespace six_feat
