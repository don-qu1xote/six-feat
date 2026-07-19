#pragma once

// ════════════════════════════════════════════════════════════════════════════
// artist_repository.hpp  —  iteration 7
//
// ArtistRepository is the single point of access for artist/song data.
// It is a thin pass-through to PersistentStore (Postgres, backed by the
// buffer cache and read replicas). [IDEA-42] The application-level L2 LRU
// cache was removed: it duplicated caching Postgres already does, and the
// LRU/TTL desync between L2 and L1 was a recurring class of bugs.
//
// Read contract (GetArtistSongs):
//   1. L1 hit with depth ≥ want → return (no network needed).
//   2. L1 partial / miss → signal caller with network_needed = true;
//      caller (CollabService / EnrichmentWorker) fetches via GeniusGateway
//      and calls WriteThrough to persist.
//
// Write contract (WriteThrough):
//   Delegates to PersistentStore.UpsertArtistSongs. L1 is the sole source
//   of truth.
//
// Neighbours (LoadNeighbours):
//   Direct delegation to PersistentStore.LoadNeighbours — this is used by
//   CollabService::FindPath to expand the BFS frontier from L1 without
//   loading entire ArtistSongs objects into memory.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/analytics.hpp"      // CollabEdge, AdjList
#include "domain/domain_types.hpp"
#include "storage/persistent_store.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

struct GetResult {
    ArtistSongs data;
    Depth       have{Depth::None};   // depth actually available
    bool        network_needed{false};
};

class ArtistRepository final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "artist-repository";

    ArtistRepository(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Read ─────────────────────────────────────────────────────────────────

    // Returns data if available at depth ≥ want without network.
    // If network_needed=true, caller must fetch and call WriteThrough.
    GetResult GetArtistSongs(const ArtistRef& ref, Depth want) const;

    // Simple ref lookup.
    std::optional<ArtistRef> Lookup(std::int64_t artist_id) const;

    // One-hop neighbours from L1 (role-filtered).  Used by FindPath.
    std::vector<CollabEdge>
    Neighbours(std::int64_t artist_id, const RoleMask& mask) const;

    // Current depth in L1.
    Depth GetFetchDepth(std::int64_t artist_id) const;

    // Artist ids with L1 depth < want, paginated (limit/offset). Used by
    // EnrichmentWorker at startup to recover interrupted background scans.
    std::vector<std::int64_t>
    ListIncompleteArtists(Depth want, int limit, int offset) const;

    // True if we have ANY data for this id.
    bool HasAny(std::int64_t id) const;

    // ── Write ────────────────────────────────────────────────────────────────

    // Write to L1. Only advances depth monotonically.
    void WriteThrough(const ArtistSongs& data, Depth new_depth);

private:
    PersistentStore& store_;
};

} // namespace six_feat
