#pragma once

// ════════════════════════════════════════════════════════════════════════════
// collab_service.hpp  —  iteration 7
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
//   Stage 0 — Direct intersection check (CheckDirectPath):
//     Fetches song lists for both endpoints in parallel and fans out
//     FetchSongDetail calls to look for a shared credit.  Returns a
//     1-hop PathContext immediately if found, avoiding BFS entirely.
//   Stage 1+ — Each round uses repo.Neighbours(id, mask) to grow the
//     adjacency list from L1 without re-loading ArtistSongs.  For nodes
//     not yet in L1 (depth < Foreground) a foreground fetch is performed.
//     The frontier is capped at `path-max-frontier-size` per round,
//     prioritising highest-weight neighbours to limit Genius RPS.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/artist_repository.hpp"
#include "domain/domain_types.hpp"
#include "enrichment/enrichment_client.hpp"
#include "genius/genius_gateway_client.hpp"

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
#include <userver/engine/semaphore.hpp>
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
    // edge_dominant_role[lo][hi] = highest-priority role string on that edge
    // [ТЗ-5 step 3] populated by FindPath / CheckDirectPath from adj weights/mask
    std::unordered_map<std::int64_t,
        std::unordered_map<std::int64_t, std::string>> edge_dominant_role;
};

// Wraps PathContext with a flag that distinguishes "truly no path" from
// "ran out of time — background enrichment is still running".
struct PathFindResult {
    PathContext ctx;
    bool        deadline_exceeded = false;  // [BUG-9 / ТЗ-3 step 4]
};

// ════════════════════════════════════════════════════════════════════════════

class CollabService final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "collab-service";

    CollabService(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Seed resolution ──────────────────────────────────────────────────────

    std::optional<ArtistRef> ResolveById(std::int64_t id,
                                          const std::string& user_token) const;

    std::variant<ArtistRef, AmbiguousResult>
    ResolveByName(const std::string& query,
                  const std::string& user_token) const;

    // ── Radial graph data ────────────────────────────────────────────────────

    // [IDEA-22] `limit_override`, when set, replaces songs-limit-fg for this
    // call only. Since the L1/L2 cache only tracks Depth (Foreground/Full),
    // not how many songs were fetched at that depth, a set override always
    // forces a fresh Genius fetch rather than trusting a cached Foreground
    // snapshot that may have been built with the smaller default limit.
    ArtistSongs BuildRadialGraph(const ArtistRef& seed,
                                  const std::string& user_token,
                                  std::optional<int> limit_override = std::nullopt) const;

    // ── Path search ──────────────────────────────────────────────────────────

    // Stage 0: direct intersection check — fans out FetchSongDetail in parallel
    // for `from`'s song list and returns a 1-hop PathContext if `to` appears in
    // any credits.  Returns empty PathContext if no direct edge is found.
    // [ТЗ-3 step 2]
    PathContext CheckDirectPath(const ArtistRef& from,
                                const ArtistRef& to,
                                const RoleMask&  mask,
                                const std::string& user_token) const;

    // [BUG-9] deadline propagated from the HTTP request.
    // Returns PathFindResult::deadline_exceeded = true when the SLA window
    // expires mid-expansion so the caller can emit "deadline_exceeded" instead
    // of "no_path" — see ТЗ-3 step 4.
    PathFindResult FindPath(const ArtistRef&         from,
                            const ArtistRef&         to,
                            const RoleMask&          mask,
                            userver::engine::Deadline deadline,
                            const std::string& user_token) const;

    double MatchThreshold() const { return gateway_.MatchThreshold(); }

    // [IDEA-50] Exposes the configured songs-limit-fg default so callers
    // (GraphHandler) can compute the *effective* per-request limit — i.e.
    // limit_override.value_or(SongsLimitFg()) — without reaching into
    // GeniusGatewayClient directly.
    int SongsLimitFg() const { return gateway_.SongsLimitFg(); }

private:
    ArtistSongs FetchFg(const ArtistRef& ref,
                        const std::string& user_token,
                        std::optional<int> limit_override = std::nullopt) const;

    // [BUG-3] Delta-append: only processes NEW ids not yet in adj.
    // Writes directly into the caller-owned adj/node_info/edge_songs.
    // [F-11] Also fills edge_songs_dedup[lo][hi][song.id] = title for every
    // edge touching `new_ids`, so multi-hop path edges carry the connecting
    // track titles (previously only CheckDirectPath's 1-hop edge did).
    void AppendAdjFromL1(const std::unordered_set<std::int64_t>& new_ids,
                         const RoleMask& mask,
                         AdjList&                                 adj,
                         std::unordered_map<std::int64_t, ArtistRef>& node_info,
                         std::unordered_map<std::int64_t,
                             std::unordered_map<std::int64_t,
                                 std::unordered_map<std::int64_t, std::string>>>&
                             edge_songs_dedup) const;

    ArtistRepository&     repo_;
    GeniusGatewayClient&  gateway_;
    EnrichmentClient&     enrichment_;
    const int         path_max_expand_rounds_;
    const int         path_max_frontier_size_;  // [ТЗ-3 step 3] cap per BFS round

    // Caps how many FetchSongDetail calls CollabService has in flight to
    // six-feat-genius-gateway at once, shared across FetchFg, CheckDirectPath
    // and (transitively, since it calls FetchFg) the FindPath frontier
    // expansion fan-out. six-feat-genius-gateway's own Foreground lane has a
    // concurrency cap (lane-fg-max-concurrent, default 8) shared across every
    // caller — firing more than that at once just queues on the gateway side
    // until this service's own client-side timeout expires, producing
    // spurious timeouts that trip the shared circuit breaker and take down
    // unrelated in-flight requests for cb-open-seconds. mutable: acquired
    // from const methods, same as engine::Mutex/Semaphore members typically
    // are — it's synchronization state, not externally-visible object state.
    mutable userver::engine::Semaphore fg_fanout_semaphore_;
};

} // namespace six_feat
