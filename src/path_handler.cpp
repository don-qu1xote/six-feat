// ════════════════════════════════════════════════════════════════════════════
// path_handler.cpp  —  iteration 4
//
// GET /api/v1/graph/path  —  Six-degrees pathfinder
//
// Algorithm overview
// ──────────────────
// Phase 1 — Resolve endpoints
//   Both "from" and "to" names are resolved to ArtistRef via
//   GeniusClient::ResolveCandidates (fuzzy) or FetchArtistById (numeric id).
//
// Phase 2 — Build in-memory CollabGraph from cache
//   Walk every ArtistSongs entry currently in the cache and build an
//   AdjList filtered by the active RoleMask.
//
// Phase 3 — BidirectionalBfs
//   Run the algorithm from analytics.cpp on the current graph.
//   If a path is found → go to Phase 5.
//   If not found AND we have not yet reached max_expand_rounds_ → Phase 4.
//
// Phase 4 — Lazy graph expansion
//   Identify which nodes on the current BFS frontier lack cached data.
//   Fan out GeniusClient::GetOrFetchArtistSongs calls in parallel coroutines
//   (utils::Async).  Merge new data into the graph, then loop back to Phase 3.
//   Expansion terminates when:
//     (a) a path is found, or
//     (b) expand_rounds reaches max_expand_rounds_, or
//     (c) no new nodes were fetched in the last round (graph saturated).
//
// Phase 5 — Build response
//   Extract the minimal subgraph (only nodes and edges on the path).
//   Compute BetweennessCentrality on this subgraph and annotate each node.
//   Emit JSON with "type":"path".
// ════════════════════════════════════════════════════════════════════════════

#include "path_handler.hpp"

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "analytics.hpp"
#include "genius_client.hpp"

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// File-private helpers
// ════════════════════════════════════════════════════════════════════════════

namespace {

// ── RoleMask parsing (same as in graph_handler.cpp) ──────────────────────

std::string ToLower(std::string v) {
  std::transform(v.begin(), v.end(), v.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return v;
}

RoleMask ParseRoleMask(const std::string &spec) {
  if (spec.empty())
    return RoleMask{};
  RoleMask m{false, false, false, false};
  std::size_t start = 0;
  while (start <= spec.size()) {
    const std::size_t comma = spec.find(',', start);
    const std::size_t len =
        (comma == std::string::npos) ? std::string::npos : comma - start;
    const std::string tok = ToLower(spec.substr(start, len));
    if (tok == "primary")
      m.primary = true;
    else if (tok == "producer")
      m.producer = true;
    else if (tok == "writer")
      m.writer = true;
    else if (tok == "featured")
      m.featured = true;
    if (comma == std::string::npos)
      break;
    start = comma + 1;
  }
  return m;
}

bool RoleAllowed(const std::string &role, const RoleMask &mask) {
  if (role == "featured")
    return mask.featured;
  if (role == "producer")
    return mask.producer;
  if (role == "writer")
    return mask.writer;
  if (role == "primary")
    return mask.primary;
  return false;
}

// ── Resolve one endpoint (name or numeric id) ────────────────────────────

// Returns nullopt and sets out_error if resolution fails.
std::optional<ArtistRef>
ResolveEndpoint(const GeniusClient &client,
                const std::string &param, // raw query string value
                double match_threshold, std::string &out_error) {
  if (param.empty()) {
    out_error = "missing parameter";
    return std::nullopt;
  }

  // Try numeric id first.
  try {
    const std::int64_t id = std::stoll(param);
    auto ref = client.FetchArtistById(id);
    if (!ref) {
      out_error = "artist id not found: " + param;
      return std::nullopt;
    }
    return ref;
  } catch (const std::invalid_argument &) { /* not numeric */
  } catch (const std::out_of_range &) {     /* not a valid id */
  }

  // Fuzzy name search.
  const auto candidates = client.ResolveCandidates(param);
  if (candidates.empty()) {
    out_error = "artist not found: " + param;
    return std::nullopt;
  }
  if (candidates.front().score < match_threshold) {
    out_error = "ambiguous artist name: " + param;
    return std::nullopt;
  }
  const auto &c = candidates.front();
  return ArtistRef{c.id, c.name, c.image, c.url};
}

// ── Build AdjList from all cached ArtistSongs (role-filtered) ────────────

// Snapshot of one artist's cached data used to build the graph.
struct ArtistSnapshot {
  ArtistRef ref;
  std::vector<SongRecord> songs;
};

// Build an undirected AdjList from a collection of ArtistSongs snapshots.
// Also populates node_info: id → ArtistRef for JSON serialisation later.
AdjList BuildAdjList(
    const std::vector<ArtistSnapshot> &snapshots, const RoleMask &mask,
    std::unordered_map<std::int64_t, ArtistRef> &node_info,
    // edge_songs[{lo,hi}] = list of song titles on that edge (for JSON)
    std::unordered_map<
        std::int64_t,
        std::unordered_map<std::int64_t, std::vector<std::string>>>
        &edge_songs) {
  AdjList adj;

  for (const auto &snap : snapshots) {
    const std::int64_t seed_id = snap.ref.id;
    node_info[seed_id] = snap.ref;

    // Track how many shared tracks exist between seed and each collaborator.
    std::unordered_map<std::int64_t, int> weights;

    for (const auto &song : snap.songs) {
      // Collect collaborators allowed by the mask.
      std::unordered_set<std::int64_t> collabs_this_song;
      for (const auto &credit : song.credits) {
        if (credit.artist.id == seed_id)
          continue;
        if (!RoleAllowed(credit.role, mask))
          continue;
        collabs_this_song.insert(credit.artist.id);
        node_info[credit.artist.id] = credit.artist;
      }
      for (const auto cid : collabs_this_song) {
        weights[cid]++;
        const std::int64_t lo = std::min(seed_id, cid);
        const std::int64_t hi = std::max(seed_id, cid);
        edge_songs[lo][hi].push_back(song.title);
      }
    }

    // Populate adjacency list (undirected: insert both directions).
    for (const auto &[cid, w] : weights) {
      adj[seed_id].push_back({cid, w});
      adj[cid].push_back({seed_id, w});
    }
  }

  return adj;
}

// Deduplicate adjacency list entries (BuildAdjList may produce duplicates
// when multiple snapshots share collaborators).
AdjList DeduplicateAdj(AdjList adj) {
  for (auto &[node, edges] : adj) {
    // Sort by neighbour, then merge weights.
    std::sort(edges.begin(), edges.end(),
              [](const CollabEdge &a, const CollabEdge &b) {
                return a.neighbour < b.neighbour;
              });
    std::vector<CollabEdge> merged;
    for (const auto &e : edges) {
      if (!merged.empty() && merged.back().neighbour == e.neighbour)
        merged.back().weight += e.weight;
      else
        merged.push_back(e);
    }
    edges = std::move(merged);
  }
  return adj;
}

// ── Identify frontier nodes that lack cached data ────────────────────────
//
// The "frontier" of a BFS that failed to find a path consists of nodes
// reachable from src or dst whose neighbours are not yet in the graph.
// We approximate this by finding nodes that ARE in the graph but whose
// ArtistSongs haven't been fetched yet (i.e. we only know them as
// collaborators, not as seeds of their own fetch).

std::vector<std::int64_t>
FindMissingNodes(const AdjList &adj,
                 const std::unordered_set<std::int64_t> &fetched_ids) {
  std::vector<std::int64_t> missing;
  for (const auto &[id, _] : adj) {
    if (!fetched_ids.count(id))
      missing.push_back(id);
  }
  return missing;
}

// ── JSON builder for path response ───────────────────────────────────────

std::string BuildPathJson(
    const ArtistRef &from_ref, const ArtistRef &to_ref,
    const std::vector<std::int64_t> &path,
    const std::unordered_map<std::int64_t, ArtistRef> &node_info,
    const std::unordered_map<
        std::int64_t,
        std::unordered_map<std::int64_t, std::vector<std::string>>> &edge_songs,
    const AdjList &adj) {
  using namespace formats::json;

  // ── Collect path node ids and build subgraph adj ──────────────────
  const std::unordered_set<std::int64_t> path_set(path.begin(), path.end());

  // Collect node ids and edges that are ON the path only.
  std::vector<std::int64_t> path_nodes(path.begin(), path.end());

  // Build a minimal AdjList for BC computation (path nodes only).
  AdjList path_adj;
  for (std::size_t i = 0; i + 1 < path.size(); ++i) {
    const std::int64_t a = path[i], b = path[i + 1];
    // Find weight between a and b.
    int w = 1;
    if (const auto it = adj.find(a); it != adj.end()) {
      for (const auto &e : it->second)
        if (e.neighbour == b) {
          w = e.weight;
          break;
        }
    }
    path_adj[a].push_back({b, w});
    path_adj[b].push_back({a, w});
  }

  // ── Betweenness centrality on the path subgraph ───────────────────
  const auto bc = BetweennessCentrality(path_adj, path_nodes);

  // ── Normalise BC scores to [0, 1] ────────────────────────────────
  double bc_max = 0.0;
  for (const auto &[id, score] : bc)
    bc_max = std::max(bc_max, score);

  // ── JSON assembly ─────────────────────────────────────────────────
  ValueBuilder root(Type::kObject);
  root["type"] = std::string{"path"};
  root["hops"] = static_cast<int>(path.size()) - 1;

  // from / to summary
  const auto emit_ref = [](const ArtistRef &r) {
    ValueBuilder b(Type::kObject);
    b["id"] = r.id;
    b["name"] = r.name;
    if (!r.image.empty())
      b["image"] = r.image;
    if (!r.url.empty())
      b["url"] = r.url;
    return b;
  };
  root["from"] = emit_ref(from_ref);
  root["to"] = emit_ref(to_ref);

  // path array (ordered list of ids)
  ValueBuilder path_arr(Type::kArray);
  for (const auto id : path)
    path_arr.PushBack(id);
  root["path"] = std::move(path_arr);

  // nodes array (only path nodes, annotated with betweenness)
  ValueBuilder nodes_arr(Type::kArray);
  for (const auto id : path_nodes) {
    ValueBuilder nb(Type::kObject);
    nb["id"] = id;
    if (const auto it = node_info.find(id); it != node_info.end()) {
      nb["name"] = it->second.name;
      if (!it->second.image.empty())
        nb["image"] = it->second.image;
      if (!it->second.url.empty())
        nb["url"] = it->second.url;
    }
    const double raw_bc = (bc.count(id) ? bc.at(id) : 0.0);
    nb["betweenness"] = raw_bc;
    nb["betweenness_normalised"] = (bc_max > 0.0) ? raw_bc / bc_max : 0.0;
    nb["is_seed"] = (id == from_ref.id || id == to_ref.id);
    nodes_arr.PushBack(std::move(nb));
  }
  root["nodes"] = std::move(nodes_arr);

  // edges array (consecutive pairs along the path)
  ValueBuilder edges_arr(Type::kArray);
  for (std::size_t i = 0; i + 1 < path.size(); ++i) {
    const std::int64_t a = path[i], b = path[i + 1];
    const std::int64_t lo = std::min(a, b), hi = std::max(a, b);

    int w = 1;
    if (const auto it = adj.find(a); it != adj.end())
      for (const auto &e : it->second)
        if (e.neighbour == b) {
          w = e.weight;
          break;
        }

    ValueBuilder eb(Type::kObject);
    eb["from"] = a;
    eb["to"] = b;
    eb["weight"] = w;

    // Shared tracks for this edge pair.
    ValueBuilder songs_arr(Type::kArray);
    if (const auto oit = edge_songs.find(lo); oit != edge_songs.end()) {
      if (const auto iit = oit->second.find(hi); iit != oit->second.end()) {
        // Deduplicate song titles.
        std::unordered_set<std::string> seen;
        for (const auto &title : iit->second) {
          if (seen.insert(title).second)
            songs_arr.PushBack(title);
        }
      }
    }
    eb["songs"] = std::move(songs_arr);
    edges_arr.PushBack(std::move(eb));
  }
  root["edges"] = std::move(edges_arr);

  return formats::json::ToString(root.ExtractValue());
}

std::string ErrorJson(const std::string &code, const std::string &message) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"path"};
  b["error"] = code;
  b["message"] = message;
  return formats::json::ToString(b.ExtractValue());
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// PathHandler — constructor
// ════════════════════════════════════════════════════════════════════════════

PathHandler::PathHandler(const components::ComponentConfig &config,
                         const components::ComponentContext &context)
    : HttpHandlerBase(config, context),
      client_(context.FindComponent<GeniusClient>()),
      max_expand_rounds_(config["path-max-expand-rounds"].As<int>(3)) {}

// ════════════════════════════════════════════════════════════════════════════
// HandleRequestThrow
// ════════════════════════════════════════════════════════════════════════════

std::string PathHandler::HandleRequestThrow(
    const server::http::HttpRequest &request,
    server::request::RequestContext & /*context*/) const {
  auto &resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  // ── Parse parameters ─────────────────────────────────────────────────
  const std::string from_param = request.GetArg("from");
  const std::string to_param = request.GetArg("to");
  const RoleMask mask = ParseRoleMask(request.GetArg("roles"));

  if (from_param.empty() || to_param.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("bad_request",
                     "'from' and 'to' query parameters are required");
  }

  // ── Phase 1: Resolve endpoints ───────────────────────────────────────
  std::string err;
  const auto from_opt =
      ResolveEndpoint(client_, from_param, client_.MatchThreshold(), err);
  if (!from_opt) {
    resp.SetStatus(server::http::HttpStatus::kNotFound);
    return ErrorJson("resolve_failed", "'from': " + err);
  }
  const auto to_opt =
      ResolveEndpoint(client_, to_param, client_.MatchThreshold(), err);
  if (!to_opt) {
    resp.SetStatus(server::http::HttpStatus::kNotFound);
    return ErrorJson("resolve_failed", "'to': " + err);
  }

  const ArtistRef from_ref = *from_opt;
  const ArtistRef to_ref = *to_opt;

  if (from_ref.id == to_ref.id) {
    // Trivial path: artist to themselves.
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["type"] = std::string{"path"};
    b["hops"] = 0;
    formats::json::ValueBuilder ref_b(formats::json::Type::kObject);
    ref_b["id"] = from_ref.id;
    ref_b["name"] = from_ref.name;
    b["from"] = ref_b;
    b["to"] = ref_b;
    formats::json::ValueBuilder p(formats::json::Type::kArray);
    p.PushBack(from_ref.id);
    b["path"] = std::move(p);
    b["nodes"] = formats::json::ValueBuilder(formats::json::Type::kArray);
    b["edges"] = formats::json::ValueBuilder(formats::json::Type::kArray);
    return formats::json::ToString(b.ExtractValue());
  }

  // ── Ensure both endpoints are in the cache ───────────────────────────
  try {
    client_.GetOrFetchArtistSongs(from_ref);
    client_.GetOrFetchArtistSongs(to_ref);
  } catch (const GeniusHttpError &e) {
    resp.SetStatus(e.status_code == 503
                       ? server::http::HttpStatus::kServiceUnavailable
                       : server::http::HttpStatus::kBadGateway);
    return ErrorJson("genius_error", e.what());
  }

  // ── Phase 2–4: BFS with lazy expansion ──────────────────────────────
  //
  // State shared across expansion rounds:
  std::unordered_set<std::int64_t>
      fetched_ids;                       // artist_ids whose songs we have
  std::vector<ArtistSnapshot> snapshots; // all cached song data

  // Helper: pull the latest cache snapshot for a set of ids into snapshots.
  const auto refresh_snapshots = [&]() {
    snapshots.clear();
    // We iterate over all known node_ids rather than the cache internals
    // to avoid exposing cache internals.  fetched_ids tracks what we loaded.
    for (const auto id : fetched_ids) {
      // We always have it: we only add to fetched_ids after a successful fetch.
      // Re-fetch from cache is cheap (in-memory LRU, no I/O).
      // We build a temporary ArtistRef with the id; name/image will be
      // populated by node_info during BuildAdjList.
      ArtistRef tmp;
      tmp.id = id;
      // Use GetOrFetch to hit the LRU — will return cached data instantly.
      try {
        ArtistSongs data = client_.GetOrFetchArtistSongs(tmp);
        snapshots.push_back({data.seed, std::move(data.songs)});
      } catch (...) { /* skip if unavailable */
      }
    }
  };

  // Seed with both endpoints (already fetched above).
  fetched_ids.insert(from_ref.id);
  fetched_ids.insert(to_ref.id);

  std::unordered_map<std::int64_t, ArtistRef> node_info;
  std::unordered_map<std::int64_t,
                     std::unordered_map<std::int64_t, std::vector<std::string>>>
      edge_songs;

  for (int round = 0; round <= max_expand_rounds_; ++round) {
    refresh_snapshots();

    // Build adjacency list from current snapshot set.
    node_info.clear();
    edge_songs.clear();
    AdjList adj =
        DeduplicateAdj(BuildAdjList(snapshots, mask, node_info, edge_songs));

    // ── Phase 3: BFS ───────────────────────────────────────────────
    const auto path = BidirectionalBfs(adj, from_ref.id, to_ref.id);
    if (!path.empty()) {
      LOG_INFO() << "[Path] found in " << (path.size() - 1) << " hops after "
                 << round << " expansion round(s)";
      return BuildPathJson(from_ref, to_ref, path, node_info, edge_songs, adj);
    }

    // No path yet — expand if budget remains.
    if (round == max_expand_rounds_)
      break;

    // ── Phase 4: Lazy expansion ────────────────────────────────────
    const auto missing = FindMissingNodes(adj, fetched_ids);
    if (missing.empty()) {
      LOG_INFO() << "[Path] graph saturated after " << round << " rounds";
      break;
    }

    LOG_INFO() << "[Path] round " << round << ": expanding " << missing.size()
               << " frontier node(s)";

    // Fan out parallel fetches for all missing frontier nodes.
    struct FetchTask {
      std::int64_t id;
      engine::TaskWithResult<std::optional<ArtistSongs>> task;
    };
    std::vector<FetchTask> tasks;
    tasks.reserve(missing.size());

    for (const auto mid : missing) {
      // Resolve the ArtistRef for this id (we may have name/image from
      // node_info).
      ArtistRef ref;
      ref.id = mid;
      if (const auto it = node_info.find(mid); it != node_info.end())
        ref = it->second;

      tasks.push_back(
          {mid, utils::Async(
                    "path-expand", [this, ref]() -> std::optional<ArtistSongs> {
                      try {
                        return client_.GetOrFetchArtistSongs(ref);
                      } catch (const std::exception &ex) {
                        LOG_WARNING() << "[Path] expansion of " << ref.id
                                      << " failed: " << ex.what();
                        return std::nullopt;
                      }
                    })});
    }

    bool any_new = false;
    for (auto &ft : tasks) {
      try {
        auto result = ft.task.Get();
        if (result && !fetched_ids.count(ft.id)) {
          fetched_ids.insert(ft.id);
          any_new = true;
        }
      } catch (const std::exception &ex) {
        LOG_WARNING() << "[Path] expand task " << ft.id << ": " << ex.what();
      }
    }

    if (!any_new) {
      LOG_INFO() << "[Path] no new nodes fetched in round " << round;
      break;
    }
  }

  // Path not found.
  LOG_INFO() << "[Path] no path found between '" << from_ref.name << "' and '"
             << to_ref.name << "'";
  return ErrorJson("no_path", "No collaboration path found between '" +
                                  from_ref.name + "' and '" + to_ref.name +
                                  "' within " +
                                  std::to_string(max_expand_rounds_) +
                                  " expansion round(s).");
}

// ════════════════════════════════════════════════════════════════════════════
// Schema
// ════════════════════════════════════════════════════════════════════════════

yaml_config::Schema PathHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(R"(
type: object
description: Six-degrees pathfinder between two artists
additionalProperties: false
properties:
    path-max-expand-rounds:
        type: integer
        description: |
            Maximum lazy-expansion rounds before giving up.
            Each round fetches the top-N songs for all frontier nodes
            not yet in the cache, then re-runs BFS.
            Higher values find longer paths but cost more Genius API calls.
        defaultDescription: '3'
)");
}

} // namespace six_feat
