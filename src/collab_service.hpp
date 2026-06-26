#pragma once

// ════════════════════════════════════════════════════════════════════════════
// collab_service.hpp  —  iteration 6
//
// CollabService is the orchestration layer (L1 in the layered model).
// Handlers call it; it calls ArtistRepository and GeniusGateway.
//
// Responsibilities:
//   • Resolve artist names/ids to ArtistRef (fuzzy or direct).
//   • BuildRadialGraph: fetch seed artist songs at Depth::Foreground,
//     trigger BG enrichment, return ArtistSongs for handler presentation.
//   • FindPath: multi-round BidirectionalBFS with L1-based frontier
//     expansion.  BFS adjacency list is built from repo.Neighbours(), not
//     from full ArtistSongs snapshots — no TOCTOU, no stale LRU ref.
//
// FG/BG split detail:
//   BuildRadialGraph fetches `songs-limit-fg` songs synchronously, returns
//   the result, and (after the handler has the data) enqueues a Full-depth
//   job for the background worker.  The handler response latency is bounded
//   by FG-lane resilience budget only.
//
// FindPath expansion:
//   Each round uses repo.Neighbours(id, mask) to grow the adjacency list
//   from L1 without re-loading ArtistSongs.  For nodes not yet in L1
//   (depth < Foreground), a foreground fetch is performed and WriteThrough
//   is called before the next BFS pass.
// ════════════════════════════════════════════════════════════════════════════

#include "artist_repository.hpp"
#include "domain_types.hpp"
#include "enrichment_worker.hpp"
#include "genius_gateway.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/deadline.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// Returned by ResolveSeed when the query matches several candidates.
struct AmbiguousResult {
    std::string        query;
    std::vector<Candidate> candidates;   // up to 6, sorted by score
};

// ── FindPath result ───────────────────────────────────────────────────────

struct PathContext {
    std::vector<std::int64_t>                    path;    // ordered ids
    AdjList                                      adj;     // full subgraph adj
    std::unordered_map<std::int64_t, ArtistRef>  node_info;
    // edge_songs[lo][hi] = deduplicated track titles on that edge
    std::unordered_map<std::int64_t,
        std::unordered_map<std::int64_t, std::vector<std::string>>> edge_songs;
};

// ════════════════════════════════════════════════════════════════════════════

class CollabService final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "collab-service";

    CollabService(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Seed resolution ──────────────────────────────────────────────────────

    std::optional<ArtistRef> ResolveById(std::int64_t id) const;

    std::variant<ArtistRef, AmbiguousResult>
    ResolveByName(const std::string& query) const;

    // ── Radial graph data ────────────────────────────────────────────────────

    ArtistSongs BuildRadialGraph(const ArtistRef& seed) const;

    // ── Path search ──────────────────────────────────────────────────────────

    // [BUG-9] deadline propagated from the HTTP request.
    // If deadline expires mid-expansion, returns the best partial path found
    // so far (may be empty) and enqueues pending frontier nodes for BG scan.
    PathContext FindPath(const ArtistRef&         from,
                         const ArtistRef&         to,
                         const RoleMask&          mask,
                         userver::engine::Deadline deadline =
                             userver::engine::Deadline::Passed()) const;

    double MatchThreshold() const { return gateway_.MatchThreshold(); }

private:
    ArtistSongs FetchFg(const ArtistRef& ref) const;

    // [BUG-3] Delta-append: only processes NEW ids not yet in adj.
    // Writes directly into the caller-owned adj/node_info/edge_songs.
    void AppendAdjFromL1(const std::unordered_set<std::int64_t>& new_ids,
                         const RoleMask& mask,
                         AdjList&                                 adj,
                         std::unordered_map<std::int64_t, ArtistRef>& node_info) const;

    ArtistRepository& repo_;
    GeniusGateway&    gateway_;
    EnrichmentWorker& worker_;
    const int         path_max_expand_rounds_;
};

} // namespace six_feat
