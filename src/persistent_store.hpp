#pragma once

// ════════════════════════════════════════════════════════════════════════════
// persistent_store.hpp  —  iteration 6
//
// L1 persistent store — the durable source of truth for artist/song/credit
// data.  Sits below ArtistRepository (L2 = LRU) and above the DBMS.
//
// Schema contract:
//   artists(id PK, name, image_url, url)
//   songs(id PK, title)
//   credits(song_id FK, artist_id FK, role SMALLINT, PK=(song_id,artist_id,role))
//   fetch_state(artist_id PK FK, depth SMALLINT, song_count INT, last_fetch_ts BIGINT)
//
// Key properties:
//   • Credits are immutable: INSERT OR IGNORE semantics — stale data is never
//     "wrong", just "less complete".  Safe to serve from L1 while CB is Open.
//   • fetch_state.depth is monotonically increasing (None→FG→Full).
//     A request for Depth::D is satisfied if depth(L1) >= D.
//   • All methods are coroutine-safe.  SQLite I/O is dispatched to
//     fs_blocking_task_processor so the coroutine parks without blocking
//     any OS thread on the main task processor.  PostgreSQL uses userver's
//     native async pg driver — no offload needed.
//
// Backend is selected at construction time via the "backend" config key
// ("sqlite" or "postgresql").  Upper layers never see this distinction.
// ════════════════════════════════════════════════════════════════════════════

#include "analytics.hpp"      // CollabEdge, AdjList
#include "domain_types.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class PersistentStore final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "persistent-store";

    PersistentStore(const userver::components::ComponentConfig&  config,
                    const userver::components::ComponentContext& context);

    ~PersistentStore() override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Read API ─────────────────────────────────────────────────────────────

    // Returns the artist's data if depth(L1) >= want; nullopt otherwise.
    // Fast path: AdjList queries use LoadNeighbours instead.
    std::optional<ArtistSongs>
    LoadArtistSongs(std::int64_t artist_id, Depth want) const;

    // Pure ArtistRef lookup — used when we know id but not name/image/url.
    std::optional<ArtistRef>
    LoadArtistRef(std::int64_t artist_id) const;

    // One-hop neighbours from L1 (role-filtered).
    // Used by CollabService::FindPath to expand the BFS frontier from L1
    // without loading entire ArtistSongs into memory.
    std::vector<CollabEdge>
    LoadNeighbours(std::int64_t artist_id, const RoleMask& mask) const;

    // Current scan depth for an artist (None if unknown).
    Depth GetFetchDepth(std::int64_t artist_id) const;

    // ── Write API ────────────────────────────────────────────────────────────

    // Atomically upsert artists, songs, credits and advance fetch_state.
    // Uses INSERT OR IGNORE for credits so concurrent writers are safe.
    // Only advances depth if new_depth > current depth(L1).
    void UpsertArtistSongs(const ArtistSongs& data, Depth new_depth);

private:
    // Pimpl hides the DBMS-specific driver (SQLite vs PostgreSQL).
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace six_feat
