
#include "application/collab_service.hpp"

#include "schemas/components/collab_service_schema.hpp"

#include <algorithm>
#include <six-feat-common/music_source_provider.hpp>
#include <six-feat-domain/role_mask.hpp>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <six-feat-sources/music_source_provider_chain.hpp>
#include <six-feat-storage/analytics.hpp>
#include <six-feat-storage/artist_repository.hpp>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/deadline.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <variant>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

int RequireNonNegative(std::string_view param, int value) {
  if (value < 0) {
    throw std::runtime_error("collab-service: " + std::string(param) +
                             " must be non-negative, got " + std::to_string(value));
  }
  return value;
}

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("collab-service: " + std::string(param) + " must be positive, got " +
                             std::to_string(value));
  }
  return value;
}

}  // namespace

CollabService::CollabService(const components::ComponentConfig& config,
                             const components::ComponentContext& context)
    : ComponentBase(config, context),
      repo_(context.FindComponent<ArtistRepository>()),
      gateway_(context.FindComponent<GeniusGatewayClient>()),
      chain_(context.FindComponent<MusicSourceProviderChain>()),
      enrichment_(context.FindComponent<EnrichmentClient>()),
      fg_fanout_(context.FindComponent<FgFanoutLimiter>()),
      path_max_expand_rounds_(RequireNonNegative("path-max-expand-rounds",
                                                 config["path-max-expand-rounds"].As<int>(3))),
      path_max_frontier_size_(RequirePositive("path-max-frontier-size",
                                              config["path-max-frontier-size"].As<int>(20))) {}

yaml_config::Schema CollabService::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kCollabServiceComponentSchema);
}

std::optional<ArtistRef> CollabService::ResolveById(std::int64_t id,
                                                    const std::string& user_token) const {
  return ResolveArtistById(repo_, gateway_, id, user_token);
}

std::variant<ArtistRef, AmbiguousResult> CollabService::ResolveByName(
    const std::string& query, const std::string& user_token) const {
  return ResolveArtistByName(gateway_, query, user_token);
}

ArtistSongs CollabService::FetchFg(const ArtistRef& ref,
                                   const std::string& user_token,
                                   std::optional<int> limit_override) const {
  const int limit = limit_override.value_or(gateway_.SongsLimitFg());

  auto out = chain_.GetArtistSongs(ref, limit, Lane::kForeground, user_token);
  out.seed = ref;

  repo_.WriteThrough(out, Depth::kForeground);
  return out;
}

ArtistSongs CollabService::BuildRadialGraph(const ArtistRef& seed,
                                            const std::string& user_token,
                                            std::optional<int> limit_override,
                                            const std::string& preferred_provider) const {
  auto result = repo_.GetArtistSongs(seed, Depth::kForeground);

  const bool force_refetch = limit_override.has_value() && !result.network_needed;

  if (result.network_needed || force_refetch) {
    try {
      result.data = FetchFg(seed, user_token, limit_override);
      result.have = Depth::kForeground;
      result.network_needed = false;
    } catch (const GeniusHttpError& e) {
      if (e.status_code == 503) {
        LOG_WARNING() << "[Service] CB open for seed=" << seed.id << ", serving from L1 fallback";
      } else if (e.status_code == 499) {
        LOG_DEBUG() << "[Service] request cancelled for seed=" << seed.id
                    << ", serving from L1 fallback";
      } else {
        throw;
      }
    }
  }
  enrichment_.EnqueueIfNeeded(seed, user_token, preferred_provider);
  return std::move(result.data);
}

void CollabService::AppendAdjFromL1(
    const std::unordered_set<std::int64_t>& new_ids,
    const RoleMask& mask,
    AdjList& adj,
    std::unordered_map<std::int64_t, ArtistRef>& node_info,
    std::unordered_map<
        std::int64_t,
        std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, std::string>>>&
        edge_songs_dedup) const {
  for (const auto id : new_ids) {
    if (!node_info.count(id)) {
      if (auto ref = repo_.Lookup(id)) node_info[id] = std::move(*ref);
    }

    const auto neighbours = repo_.Neighbours(id, mask);
    if (neighbours.empty()) continue;

    std::unordered_set<std::int64_t> neighbour_ids;
    neighbour_ids.reserve(neighbours.size());

    auto& id_adj = adj[id];
    id_adj.reserve(id_adj.size() + neighbours.size());
    for (const auto& edge : neighbours) {
      const std::int64_t nid = edge.neighbour;
      id_adj.push_back({edge.neighbour, edge.weight, edge.source});
      adj[nid].push_back({id, edge.weight, edge.source});
      neighbour_ids.insert(nid);

      if (!node_info.count(nid)) {
        if (auto ref = repo_.Lookup(nid)) node_info[nid] = std::move(*ref);
      }
    }

    ArtistRef fallback;
    fallback.id = id;
    const auto node_it = node_info.find(id);
    const ArtistRef& fref = node_it != node_info.end() ? node_it->second : fallback;
    const auto res = repo_.GetArtistSongs(fref, Depth::kForeground);
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

PathContext CollabService::CheckDirectPath(const ArtistRef& from,
                                           const ArtistRef& to,
                                           const RoleMask& mask,
                                           const std::string& user_token) const {
  const int limit = gateway_.SongsLimitFg();

  auto task_from = utils::Async("direct-songlist-from", [&] {
    return gateway_.FetchSongList(from.id, limit, Lane::kForeground, user_token);
  });
  auto task_to = utils::Async("direct-songlist-to", [&] {
    return gateway_.FetchSongList(to.id, limit, Lane::kForeground, user_token);
  });

  std::vector<std::int64_t> from_songs, to_songs;
  try {
    from_songs = task_from.Get();
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[Service] CheckDirectPath songlist from=" << from.id << ": " << ex.what();
  }
  try {
    to_songs = task_to.Get();
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[Service] CheckDirectPath songlist to=" << to.id << ": " << ex.what();
  }

  if (from_songs.empty()) return PathContext{};

  const std::unordered_set<std::int64_t> to_song_set(to_songs.begin(), to_songs.end());

  struct DetailTask {
    std::int64_t song_id;
    engine::TaskWithResult<std::optional<SongRecord>> task;
  };
  std::vector<DetailTask> detail_tasks;
  detail_tasks.reserve(from_songs.size());
  for (const auto sid : from_songs) {
    detail_tasks.push_back({sid, utils::Async("direct-song-detail", [this, sid, &user_token] {
                              engine::SemaphoreLock lock{fg_fanout_.Semaphore()};
                              return gateway_.FetchSongDetail(sid, Lane::kForeground, user_token);
                            })});
  }

  for (auto& dt : detail_tasks) {
    std::optional<SongRecord> rec;
    try {
      rec = dt.task.Get();
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[Service] CheckDirectPath detail song=" << dt.song_id << ": " << ex.what();
      continue;
    }
    if (!rec) continue;

    bool found = false;
    for (const auto& credit : rec->credits) {
      if (credit.artist.id == to.id) {
        if (!RoleAllowed(credit.role, mask)) continue;
        found = true;
        break;
      }
    }
    if (!found) continue;

    LOG_INFO() << "[Service] CheckDirectPath: direct edge " << from.id << " — " << to.id
               << " via song " << dt.song_id;

    PathContext ctx;
    ctx.path = {from.id, to.id};

    const std::int64_t lo = std::min(from.id, to.id);
    const std::int64_t hi = std::max(from.id, to.id);
    ctx.adj[from.id].push_back({to.id, 1});
    ctx.adj[to.id].push_back({from.id, 1});
    ctx.edge_songs[lo][hi].push_back(rec->title);
    ctx.node_info[from.id] = from;
    ctx.node_info[to.id] = to;

    std::string dominant = "primary";
    for (const char* priority_role : {"featured", "primary", "producer", "writer"}) {
      bool found_role = false;
      for (const auto& credit : rec->credits) {
        if (credit.artist.id != to.id) continue;
        if (!RoleAllowed(credit.role, mask)) continue;
        if (credit.role == priority_role) {
          dominant = priority_role;
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

PathFindResult CollabService::FindPath(const ArtistRef& from,
                                       const ArtistRef& to,
                                       const RoleMask& mask,
                                       engine::Deadline deadline,
                                       const std::string& user_token,
                                       const std::string& preferred_provider) const {
  {
    auto direct = CheckDirectPath(from, to, mask, user_token);
    if (!direct.path.empty()) {
      LOG_INFO() << "[Service] FindPath: direct edge found in stage 0";
      return PathFindResult{std::move(direct), false};
    }
  }

  {
    auto rf = repo_.GetArtistSongs(from, Depth::kForeground);
    if (rf.network_needed) {
      try {
        FetchFg(from, user_token);
      } catch (const std::exception& ex) {
        LOG_WARNING() << "[Service] FindPath pre-warm from=" << from.id << ": " << ex.what();
      }
    }
  }
  {
    auto rt = repo_.GetArtistSongs(to, Depth::kForeground);
    if (rt.network_needed) {
      try {
        FetchFg(to, user_token);
      } catch (const std::exception& ex) {
        LOG_WARNING() << "[Service] FindPath pre-warm to=" << to.id << ": " << ex.what();
      }
    }
  }

  std::unordered_set<std::int64_t> known_ids{from.id, to.id};

  const auto pre_warm = [&](std::int64_t id) {
    for (const auto& edge : repo_.Neighbours(id, mask)) {
      const std::int64_t nid = edge.neighbour;
      if (repo_.GetFetchDepth(nid) >= Depth::kForeground) known_ids.insert(nid);
    }
  };
  pre_warm(from.id);
  pre_warm(to.id);

  AdjList adj;
  std::unordered_map<std::int64_t, ArtistRef> node_info;
  std::unordered_map<
      std::int64_t,
      std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, std::string>>>
      edge_songs_dedup;

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
      LOG_WARNING() << "[Service] FindPath deadline exceeded at round " << round
                    << ", delegating frontier to BG";
      for (const auto& [nid, edges] : adj) {
        if (!known_ids.count(nid)) {
          ArtistRef fref;
          fref.id = nid;
          if (const auto it = node_info.find(nid); it != node_info.end()) fref = it->second;
          enrichment_.EnqueueIfNeeded(fref, user_token, preferred_provider);
        }
      }
      return PathFindResult{{}, true};
    }

    const auto path = BidirectionalBfs(adj, from.id, to.id);
    if (!path.empty()) {
      LOG_INFO() << "[Service] path found: " << (path.size() - 1) << " hops, " << round
                 << " round(s)";

      std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, std::vector<std::string>>>
          edge_songs_out;
      for (const auto& [lo, hi_map] : edge_songs_dedup)
        for (const auto& [hi, song_map] : hi_map) {
          auto& titles = edge_songs_out[lo][hi];
          titles.reserve(song_map.size());
          for (const auto& [song_id, title] : song_map) titles.push_back(title);
        }

      std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, std::string>>
          edge_dominant_role;

      struct RoleProbe {
        const char* name = nullptr;
        RoleMask single = {};
      };
      const std::array<RoleProbe, 4> probes{{{"producer", ParseRoleMask("producer")},
                                             {"writer", ParseRoleMask("writer")},
                                             {"featured", ParseRoleMask("featured")},
                                             {"primary", ParseRoleMask("primary")}}};

      for (std::size_t i = 0; i + 1 < path.size(); ++i) {
        const std::int64_t a = path[i];
        const std::int64_t b = path[i + 1];
        const std::int64_t lo = std::min(a, b);
        const std::int64_t hi = std::max(a, b);
        if (edge_dominant_role[lo].count(hi)) continue;

        std::string dominant = "primary";
        for (const auto& probe : probes) {
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

      PathContext ctx{path,
                      adj,
                      std::move(node_info),
                      std::move(edge_songs_out),
                      std::move(edge_dominant_role)};
      return PathFindResult{std::move(ctx), false};
    }

    if (round == path_max_expand_rounds_) break;

    struct FrontierEntry {
      ArtistRef ref;
      int weight = 0;
    };
    std::vector<FrontierEntry> frontier_candidates;
    frontier_candidates.reserve(adj.size());
    for (const auto& [nid, edges] : adj) {
      if (known_ids.count(nid)) continue;
      if (repo_.GetFetchDepth(nid) >= Depth::kForeground) {
        known_ids.insert(nid);
        continue;
      }
      ArtistRef fref;
      fref.id = nid;
      if (const auto it = node_info.find(nid); it != node_info.end()) fref = it->second;

      int total_weight = 0;
      for (const auto& e : edges) total_weight += e.weight;
      frontier_candidates.push_back({std::move(fref), total_weight});
    }

    std::sort(frontier_candidates.begin(),
              frontier_candidates.end(),
              [](const FrontierEntry& a, const FrontierEntry& b) { return a.weight > b.weight; });
    if (static_cast<int>(frontier_candidates.size()) > path_max_frontier_size_) {
      LOG_INFO() << "[Service] round " << round << ": capping frontier from "
                 << frontier_candidates.size() << " to " << path_max_frontier_size_;
      frontier_candidates.resize(static_cast<std::size_t>(path_max_frontier_size_));
    }

    if (frontier_candidates.empty()) {
      LOG_INFO() << "[Service] graph saturated after " << round << " round(s)";
      break;
    }

    LOG_INFO() << "[Service] round " << round << ": expanding " << frontier_candidates.size()
               << " frontier node(s)";

    struct ExpandTask {
      ArtistRef ref;
      engine::TaskWithResult<void> task;
    };
    std::vector<ExpandTask> tasks;
    tasks.reserve(frontier_candidates.size());
    for (auto& fe : frontier_candidates) {
      ArtistRef fref_for_task = fe.ref;
      tasks.push_back({std::move(fref_for_task),
                       utils::Async("path-expand", [this, fref = std::move(fe.ref), user_token] {
                         try {
                           FetchFg(fref, user_token);
                         } catch (const std::exception& ex) {
                           LOG_WARNING() << "[Service] expand " << fref.id << ": " << ex.what();
                         }
                       })});
    }
    for (auto& et : tasks) {
      try {
        et.task.Get();
      } catch (const std::exception& ex) {
        LOG_WARNING() << "[Service] expand task " << et.ref.id << ": " << ex.what();
      }
      known_ids.insert(et.ref.id);
      enrichment_.EnqueueIfNeeded(et.ref, user_token, preferred_provider);
    }

    append_delta();
  }

  LOG_INFO() << "[Service] no path found between " << from.id << " and " << to.id;
  return PathFindResult{{}, false};
}

RadialGraphResult CollabService::BuildRadialGraphWithSource(
    const ArtistRef& seed,
    const std::string& user_token,
    std::optional<int> limit_override,
    const std::string& preferred_provider) const {
  RadialGraphResult result;
  result.data = BuildRadialGraph(seed, user_token, limit_override, preferred_provider);

  std::unordered_map<std::int64_t, bool> all_yandex;
  for (const auto& song : result.data.songs) {
    const bool from_yandex = IsYandexSongId(song.id);
    for (const auto& credit : song.credits) {
      const std::int64_t other = credit.artist.id;
      if (!other || other == seed.id) continue;
      auto [it, inserted] = all_yandex.try_emplace(other, from_yandex);
      if (!inserted) it->second = it->second && from_yandex;
    }
  }

  for (const auto& [other, yandex_only] : all_yandex) {
    const std::int64_t lo = std::min(seed.id, other);
    const std::int64_t hi = std::max(seed.id, other);
    result.edge_sources[lo][hi] =
        yandex_only ? EdgeSource::kYandexFeature : EdgeSource::kGeniusCredit;
  }

  return result;
}

}  // namespace six_feat