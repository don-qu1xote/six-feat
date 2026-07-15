// ════════════════════════════════════════════════════════════════════════════
// collab_service.cpp  —  iteration 8
//
// Bug fixes: [BUG-3] [BUG-6] [BUG-7] [BUG-9]
// ТЗ-3 changes:
//   • CheckDirectPath — stage-0 direct intersection via FetchSongDetail fan-out
//   • FindPath — calls CheckDirectPath first, caps BFS frontier, returns
//     PathFindResult with deadline_exceeded flag instead of bare PathContext
//   • path_max_frontier_size_ — new config key path-max-frontier-size (default 20)
// ════════════════════════════════════════════════════════════════════════════

#include "core/collab_service.hpp"
#include "storage/analytics.hpp"
#include "domain/role_mask.hpp"

#include <algorithm>
#include <stdexcept>
#include <string>
#include <string_view>
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

#include "schemas/components/collab_service_schema.hpp"

namespace six_feat {

using namespace userver;

namespace {

// Max ambiguous-name candidates surfaced to the client for a picker UI when
// the top fuzzy match isn't confident enough.
constexpr std::size_t kMaxAmbiguousCandidates = 6;

// path-max-expand-rounds may legitimately be 0 (stage-0 direct check only,
// no BFS expansion) but a negative value silently disables expansion the
// same way while looking like a config mistake — reject it explicitly.
int RequireNonNegative(std::string_view param, int value) {
    if (value < 0) {
        throw std::runtime_error(
            "collab-service: " + std::string(param) +
            " must be non-negative, got " + std::to_string(value));
    }
    return value;
}

// path-max-frontier-size is cast to std::size_t for std::vector::resize;
// a non-positive value either does nothing useful (0) or wraps into a huge
// resize (negative), so require strictly positive.
int RequirePositive(std::string_view param, int value) {
    if (value <= 0) {
        throw std::runtime_error(
            "collab-service: " + std::string(param) +
            " must be non-negative, got " + std::to_string(value));
    }
    return value;
}

} // namespace

CollabService::CollabService(const components::ComponentConfig&  config,
                              const components::ComponentContext& context)
    : ComponentBase(config, context),
      repo_(context.FindComponent<ArtistRepository>()),
      gateway_(context.FindComponent<GeniusGatewayClient>()),
      enrichment_(context.FindComponent<EnrichmentClient>()),
      path_max_expand_rounds_(RequireNonNegative(
          "path-max-expand-rounds",
          config["path-max-expand-rounds"].As<int>(3))),
      path_max_frontier_size_(RequirePositive(
          "path-max-frontier-size",
          config["path-max-frontier-size"].As<int>(20))),
      fg_fanout_semaphore_(static_cast<std::size_t>(RequirePositive(
          "fg-fanout-max-concurrent",
          config["fg-fanout-max-concurrent"].As<int>(6))))
{}

yaml_config::Schema CollabService::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(kCollabServiceComponentSchema);
}

std::optional<ArtistRef> CollabService::ResolveById(
    std::int64_t id, const std::string& user_token) const {
    if (auto ref = repo_.Lookup(id)) return ref;
    return gateway_.FetchArtistById(id, Lane::Foreground, user_token);
}

std::variant<ArtistRef, AmbiguousResult>
CollabService::ResolveByName(const std::string& query,
                             const std::string& user_token) const {
    const auto candidates = gateway_.ResolveCandidates(query, user_token);
    if (candidates.empty()) {
        AmbiguousResult ar; ar.query = query; return ar;
    }
    const auto& best = candidates.front();
    if (best.score < gateway_.MatchThreshold()) {
        AmbiguousResult ar;
        ar.query = query;
        const std::size_t limit =
            std::min<std::size_t>(candidates.size(), kMaxAmbiguousCandidates);
        ar.candidates.assign(candidates.begin(),
                             candidates.begin() +
                             static_cast<std::ptrdiff_t>(limit));
        return ar;
    }
    return ArtistRef{best.id, best.name, best.image, best.url};
}

ArtistSongs CollabService::FetchFg(const ArtistRef& ref,
                                    const std::string& user_token,
                                    std::optional<int> limit_override) const {
    const int limit = limit_override.value_or(gateway_.SongsLimitFg());
    const auto song_ids = gateway_.FetchSongList(ref.id, limit,
                                                  Lane::Foreground, user_token);

    struct Pending {
        std::int64_t id;
        engine::TaskWithResult<std::optional<SongRecord>> task;
    };
    std::vector<Pending> pending;
    pending.reserve(song_ids.size());
    for (const auto sid : song_ids) {
        pending.push_back({sid, utils::Async(
            "fg-song-detail",
            [this, sid, &user_token] {
                engine::SemaphoreLock lock{fg_fanout_semaphore_};
                return gateway_.FetchSongDetail(sid, Lane::Foreground, user_token);
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

ArtistSongs CollabService::BuildRadialGraph(const ArtistRef& seed,
                                             const std::string& user_token,
                                             std::optional<int> limit_override) const {
    auto result = repo_.GetArtistSongs(seed, Depth::Foreground);

    // [IDEA-22] An explicit override means the caller wants more songs than
    // whatever is cached — the cache only remembers Depth, not the limit a
    // prior fetch used, so a cache hit alone can't tell us the stored data
    // is already big enough. Always refetch fresh in that case.
    const bool force_refetch = limit_override.has_value() && !result.network_needed;

    if (result.network_needed || force_refetch) {
        try {
            result.data         = FetchFg(seed, user_token, limit_override);
            result.have         = Depth::Foreground;
            result.network_needed = false;
        } catch (const GeniusHttpError& e) {
            if (e.status_code == 503) {
                LOG_WARNING() << "[Service] CB open for seed=" << seed.id
                              << ", serving from L1 fallback";
            } else if (e.status_code == 499) {
                // [FIX] Client disconnected mid-request (see genius_gateway.cpp).
                // The original HTTP response is going nowhere either way, so
                // just serve whatever L1 data we have instead of treating this
                // as a real Genius failure.
                LOG_DEBUG() << "[Service] request cancelled for seed=" << seed.id
                            << ", serving from L1 fallback";
            } else {
                throw;
            }
        }
    }
    enrichment_.EnqueueIfNeeded(seed, user_token);
    return std::move(result.data);
}

void CollabService::AppendAdjFromL1(
    const std::unordered_set<std::int64_t>& new_ids,
    const RoleMask&                          mask,
    AdjList&                                 adj,
    std::unordered_map<std::int64_t, ArtistRef>& node_info,
    std::unordered_map<std::int64_t,
        std::unordered_map<std::int64_t,
            std::unordered_map<std::int64_t, std::string>>>& edge_songs_dedup) const
{
    for (const auto id : new_ids) {
        if (!node_info.count(id)) {
            if (auto ref = repo_.Lookup(id)) node_info[id] = std::move(*ref);
        }

        const auto neighbours = repo_.Neighbours(id, mask);
        if (neighbours.empty()) continue;

        std::unordered_set<std::int64_t> neighbour_ids;
        neighbour_ids.reserve(neighbours.size());

        // [SF-PERF-05] adj[id] receives exactly neighbours.size() new
        // entries in this loop — reserve up front instead of letting
        // push_back grow it round-by-round. Cache the reference too: it
        // stays valid across the adj[nid] inserts below (unordered_map
        // insertion never invalidates references to existing elements,
        // only iterators), so there's no need to re-look-up adj[id] on
        // every edge.
        auto& id_adj = adj[id];
        id_adj.reserve(id_adj.size() + neighbours.size());
        for (const auto& edge : neighbours) {
            const std::int64_t nid = edge.neighbour;
            id_adj.push_back(edge);
            adj[nid].push_back({id, edge.weight});
            neighbour_ids.insert(nid);

            if (!node_info.count(nid)) {
                if (auto ref = repo_.Lookup(nid)) node_info[nid] = std::move(*ref);
            }
        }

        // [F-11] Fill edge_songs_dedup with the tracks connecting `id` to
        // each of its neighbours, from L1 credit data — mirrors what
        // CheckDirectPath does for the 1-hop case, so multi-hop path edges
        // also carry non-empty songs[]. Dedup by song.id.
        // [SF-PERF-05] node_info[id] was just populated above (or already
        // present) — reference it directly instead of copying the
        // ArtistRef (3 strings) purely to pass it to GetArtistSongs.
        // `fallback` only matters if repo_.Lookup(id) failed above (no L1
        // row for this id at all) — same id-only value the previous
        // "ArtistRef fref; fref.id = id;" default carried.
        ArtistRef fallback;
        fallback.id = id;
        const auto node_it = node_info.find(id);
        const ArtistRef& fref = node_it != node_info.end() ? node_it->second : fallback;
        const auto res = repo_.GetArtistSongs(fref, Depth::Foreground);
        if (res.network_needed) continue;

        for (const auto& song : res.data.songs) {
            for (const auto& credit : song.credits) {
                const std::int64_t nid = credit.artist.id;
                if (nid == id || !neighbour_ids.count(nid)) continue;
                if (!RoleAllowed(credit.role, mask)) continue;

                const std::int64_t lo = std::min(id, nid);
                const std::int64_t hi = std::max(id, nid);
                edge_songs_dedup[lo][hi][song.id] = song.title;
            }
        }
    }
}

// ── Stage-0 direct intersection check ────────────────────────────────────
// [ТЗ-3 step 2]
// Fetch song lists for both artists in parallel, then fan out FetchSongDetail
// calls for `from`'s songs to find `to` in the credits.  Returns a 1-hop
// PathContext immediately if found; empty PathContext otherwise.
PathContext CollabService::CheckDirectPath(const ArtistRef& from,
                                            const ArtistRef& to,
                                            const RoleMask&  mask,
                                            const std::string& user_token) const
{
    const int limit = gateway_.SongsLimitFg();

    // Fetch both song lists concurrently.
    auto task_from = utils::Async("direct-songlist-from", [&] {
        return gateway_.FetchSongList(from.id, limit, Lane::Foreground, user_token);
    });
    auto task_to = utils::Async("direct-songlist-to", [&] {
        return gateway_.FetchSongList(to.id, limit, Lane::Foreground, user_token);
    });

    std::vector<std::int64_t> from_songs, to_songs;
    try { from_songs = task_from.Get(); } catch (const std::exception& ex) {
        LOG_WARNING() << "[Service] CheckDirectPath songlist from=" << from.id
                      << ": " << ex.what();
    }
    try { to_songs = task_to.Get(); } catch (const std::exception& ex) {
        LOG_WARNING() << "[Service] CheckDirectPath songlist to=" << to.id
                      << ": " << ex.what();
    }

    if (from_songs.empty()) return PathContext{};

    // Build a fast lookup of `to`'s song ids so we can spot shared songs
    // without fetching detail (cheap shortcut before the credit fan-out).
    const std::unordered_set<std::int64_t> to_song_set(
        to_songs.begin(), to_songs.end());

    // Fan out FetchSongDetail for `from`'s songs in parallel.
    struct DetailTask {
        std::int64_t song_id;
        engine::TaskWithResult<std::optional<SongRecord>> task;
    };
    std::vector<DetailTask> detail_tasks;
    detail_tasks.reserve(from_songs.size());
    for (const auto sid : from_songs) {
        detail_tasks.push_back({sid, utils::Async(
            "direct-song-detail",
            [this, sid, &user_token] {
                engine::SemaphoreLock lock{fg_fanout_semaphore_};
                return gateway_.FetchSongDetail(sid, Lane::Foreground, user_token);
            }
        )});
    }

    // Collect results; return on the first confirmed shared credit.
    for (auto& dt : detail_tasks) {
        std::optional<SongRecord> rec;
        try { rec = dt.task.Get(); } catch (const std::exception& ex) {
            LOG_WARNING() << "[Service] CheckDirectPath detail song="
                          << dt.song_id << ": " << ex.what();
            continue;
        }
        if (!rec) continue;

        // Check whether `to` appears among this song's featured artists.
        bool found = false;
        for (const auto& credit : rec->credits) {
            if (credit.artist.id == to.id) {
                // Respect role mask — skip if this role isn't requested.
                if (!RoleAllowed(credit.role, mask)) continue;
                found = true;
                break;
            }
        }
        if (!found) continue;

        LOG_INFO() << "[Service] CheckDirectPath: direct edge "
                   << from.id << " — " << to.id
                   << " via song " << dt.song_id;

        // Build a minimal 1-hop PathContext.
        PathContext ctx;
        ctx.path = {from.id, to.id};

        const std::int64_t lo = std::min(from.id, to.id);
        const std::int64_t hi = std::max(from.id, to.id);
        ctx.adj[from.id].push_back({to.id, 1});
        ctx.adj[to.id].push_back({from.id, 1});
        ctx.edge_songs[lo][hi].push_back(rec->title);
        ctx.node_info[from.id] = from;
        ctx.node_info[to.id]   = to;

        // [ТЗ-5 step 3] Derive dominant role from the winning song's credits.
        // Iterate in priority order; pick the first role that touches `to`.
        std::string dominant = "primary";
        for (const char* priority_role :
                {"featured", "primary", "producer", "writer"}) {
            bool found_role = false;
            for (const auto& credit : rec->credits) {
                if (credit.artist.id != to.id)          continue;
                if (!RoleAllowed(credit.role, mask))     continue;
                if (credit.role == priority_role) {
                    dominant   = priority_role;
                    found_role = true;
                    break;
                }
            }
            if (found_role) break;
        }
        ctx.edge_dominant_role[lo][hi] = std::move(dominant);
        return ctx;
    }

    return PathContext{};
}

PathFindResult CollabService::FindPath(const ArtistRef&   from,
                                     const ArtistRef&   to,
                                     const RoleMask&    mask,
                                     engine::Deadline   deadline,
                                     const std::string& user_token) const
{
    // ── Stage 0: direct intersection check ───────────────────────────────
    // [ТЗ-3 step 2] Fan out FetchSongDetail for `from`'s top-N songs and
    // look for `to` in credits.  1 + N requests, all parallel — much cheaper
    // than a full BFS expansion for directly-connected artists.
    {
        auto direct = CheckDirectPath(from, to, mask, user_token);
        if (!direct.path.empty()) {
            LOG_INFO() << "[Service] FindPath: direct edge found in stage 0";
            return PathFindResult{std::move(direct), false};
        }
    }

    // ── Stage 1+: BFS expansion ───────────────────────────────────────────
    {
        auto rf = repo_.GetArtistSongs(from, Depth::Foreground);
        if (rf.network_needed) { try { FetchFg(from, user_token); } catch (...) {} }
    }
    {
        auto rt = repo_.GetArtistSongs(to, Depth::Foreground);
        if (rt.network_needed) { try { FetchFg(to, user_token); } catch (...) {} }
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
    // edge_songs_dedup[lo][hi][song.id] = title — dedup keyed by song.id.
    std::unordered_map<std::int64_t,
        std::unordered_map<std::int64_t,
            std::unordered_map<std::int64_t, std::string>>> edge_songs_dedup;

    std::unordered_set<std::int64_t> processed_ids;

    const auto append_delta = [&]() {
        std::unordered_set<std::int64_t> delta;
        for (const auto id : known_ids)
            if (!processed_ids.count(id)) delta.insert(id);
        AppendAdjFromL1(delta, mask, adj, node_info, edge_songs_dedup);
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
                    enrichment_.EnqueueIfNeeded(fref, user_token);
                }
            }
            // [ТЗ-3 step 4] Signal deadline_exceeded so the handler can emit
            // "deadline_exceeded" instead of the misleading "no_path" code.
            return PathFindResult{{}, true};
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
                for (const auto& [hi, song_map] : hi_map) {
                    auto& titles = edge_songs_out[lo][hi];
                    titles.reserve(song_map.size());
                    for (const auto& [song_id, title] : song_map)
                        titles.push_back(title);
                }

            // [ТЗ-5 step 3] Build edge_dominant_role for each hop along the path.
            // CollabEdge carries no role string, so we probe repo_.Neighbours
            // with single-role masks (built via ParseRoleMask) in RoleRank order:
            // producer > writer > featured > primary.  The first probe that
            // returns the target neighbour wins.
            std::unordered_map<std::int64_t,
                std::unordered_map<std::int64_t, std::string>> edge_dominant_role;

            // Ordered highest-rank first (matches RoleRank: producer=4 > writer=3
            // > featured=2 > primary=1) and pre-filtered by the request mask.
            struct RoleProbe { const char* name; RoleMask single; };
            const std::array<RoleProbe, 4> kProbes{{
                {"producer", ParseRoleMask("producer")},
                {"writer",   ParseRoleMask("writer")},
                {"featured", ParseRoleMask("featured")},
                {"primary",  ParseRoleMask("primary")}
            }};

            for (std::size_t i = 0; i + 1 < path.size(); ++i) {
                const std::int64_t a  = path[i];
                const std::int64_t b  = path[i + 1];
                const std::int64_t lo = std::min(a, b);
                const std::int64_t hi = std::max(a, b);
                if (edge_dominant_role[lo].count(hi)) continue;

                std::string dominant = "primary";
                for (const auto& probe : kProbes) {
                    if (!RoleAllowed(probe.name, mask)) continue;
                    for (const auto& e : repo_.Neighbours(a, probe.single)) {
                        if (e.neighbour == b) {
                            dominant = probe.name;
                            goto role_found;
                        }
                    }
                }
                role_found:
                edge_dominant_role[lo][hi] = std::move(dominant);
            }

            PathContext ctx{path, adj,
                            std::move(node_info),
                            std::move(edge_songs_out),
                            std::move(edge_dominant_role)};
            return PathFindResult{std::move(ctx), false};
        }

        if (round == path_max_expand_rounds_) break;

        // ── Build frontier, cap by weight (highest-weight first) ─────────
        // [ТЗ-3 step 3] Limit the number of nodes expanded per round so we
        // don't fan out hundreds of Genius requests for dense sub-graphs.
        struct FrontierEntry {
            ArtistRef ref;
            int       weight = 0;
        };
        std::vector<FrontierEntry> frontier_candidates;
        // [SF-PERF-05] adj.size() is a cheap, always-available upper bound
        // on how many candidates this loop can produce (it can only ever
        // skip entries, never add more than one per adj key) — reserving
        // it avoids frontier_candidates' growth-reallocation copies, which
        // each move a full ArtistRef (3 strings).
        frontier_candidates.reserve(adj.size());
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

            // Sum edge weights into this node as a rough connectivity score.
            int total_weight = 0;
            for (const auto& e : edges) total_weight += e.weight;
            frontier_candidates.push_back({std::move(fref), total_weight});
        }

        // Sort descending by weight and take the top path_max_frontier_size_.
        std::sort(frontier_candidates.begin(), frontier_candidates.end(),
                  [](const FrontierEntry& a, const FrontierEntry& b) {
                      return a.weight > b.weight;
                  });
        if (static_cast<int>(frontier_candidates.size()) > path_max_frontier_size_) {
            LOG_INFO() << "[Service] round " << round
                       << ": capping frontier from "
                       << frontier_candidates.size()
                       << " to " << path_max_frontier_size_;
            frontier_candidates.resize(
                static_cast<std::size_t>(path_max_frontier_size_));
        }

        if (frontier_candidates.empty()) {
            LOG_INFO() << "[Service] graph saturated after " << round << " round(s)";
            break;
        }

        LOG_INFO() << "[Service] round " << round
                   << ": expanding " << frontier_candidates.size()
                   << " frontier node(s)";

        struct ExpandTask {
            ArtistRef ref;
            engine::TaskWithResult<void> task;
        };
        std::vector<ExpandTask> tasks;
        tasks.reserve(frontier_candidates.size());
        for (auto& fe : frontier_candidates) {
            // [SF-PERF-05] Was 3 full ArtistRef copies per frontier node
            // (local fref, ExpandTask::ref, lambda capture) — now exactly
            // one: fref_for_task is kept for the known_ids/EnqueueIfNeeded
            // use below, and the async lambda gets fe.ref moved out
            // directly (frontier_candidates isn't read again after this
            // loop, so it's safe to consume).
            ArtistRef fref_for_task = fe.ref;
            tasks.push_back({std::move(fref_for_task), utils::Async(
                "path-expand",
                [this, fref = std::move(fe.ref), user_token] {
                    try { FetchFg(fref, user_token); } catch (const std::exception& ex) {
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
            enrichment_.EnqueueIfNeeded(et.ref, user_token);
        }

        append_delta();
    }

    LOG_INFO() << "[Service] no path found between "
               << from.id << " and " << to.id;
    return PathFindResult{{}, false};
}

} // namespace six_feat
