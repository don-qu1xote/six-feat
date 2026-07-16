#pragma once

// ════════════════════════════════════════════════════════════════════════════
// persistent_store.hpp  —  iteration 7
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
//   • Credits are immutable: INSERT ... ON CONFLICT DO NOTHING semantics —
//     stale data is never "wrong", just "less complete".  Safe to serve from
//     L1 while CB is Open.
//   • fetch_state.depth is monotonically increasing (None→FG→Full).
//     A request for Depth::D is satisfied if depth(L1) >= D.
//   • All methods are coroutine-safe.  Queries go through
//     userver::storages::postgres::Cluster, whose driver is itself
//     coroutine-aware (suspends the calling coroutine on I/O without
//     blocking an OS thread) — no separate blocking-task-processor dispatch
//     is needed, unlike the previous SQLite backend.
//
// Backend: PostgreSQL via userver::components::Postgres. Reads are routed to
// a Slave host, writes to Master; the cluster's own connection pool provides
// the concurrency the old read-pool/write-mutex split used to provide by
// hand. See DEVELOPMENT.md ("Postgres cluster topology") for cluster
// topology requirements.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/analytics.hpp"      // CollabEdge, AdjList
#include "domain/domain_types.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// ── Fetch state snapshot (depth + aggregate counts) ─────────────────────────

struct FetchState {
    Depth        depth{Depth::None};
    int          song_count{0};
    std::int64_t last_fetch_ts{0};
};

class PersistentStore final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "persistent-store";

    PersistentStore(const userver::components::ComponentConfig&  config,
                    const userver::components::ComponentContext& context);

    ~PersistentStore() override;

    // [fix] postgres-db-1 may run with sync-start: false specifically so an
    // unreachable/slow-starting DB doesn't block this process from coming
    // up at all (see static_config.yaml's own comment on that key) — but
    // migrations used to run synchronously in the constructor, blocking
    // component startup for the whole retry budget (~29s) and then killing
    // the process outright once it gave up, which defeated the point.
    // Migrations now run in the background once every component is up, so
    // the server starts accepting connections immediately; Ping()/readyz
    // reflect live DB reachability regardless of whether migrations have
    // completed yet. migration_task_'s destructor (reverse-declaration-order,
    // runs before impl_'s) cancels and waits for it, same as ~PersistentStore
    // being = default is enough — no separate OnAllComponentsAreStopping
    // override needed.
    void OnAllComponentsLoaded() override;

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

    // Full fetch-state row: depth + song_count + last_fetch_ts.
    // Returns zeroed FetchState if the artist has no row in fetch_state.
    FetchState GetFetchState(std::int64_t artist_id) const;

    // Artist ids whose fetch_state.depth < want, ordered by artist_id for
    // stable pagination. Used by EnrichmentWorker at startup to recover
    // interrupted background scans (IDEA-18). Callers page through with
    // limit/offset instead of loading the whole table at once.
    std::vector<std::int64_t>
    ListIncompleteArtists(Depth want, int limit, int offset) const;

    // Readiness probe: runs "SELECT 1" against the cluster (Slave host).
    // Returns false (never throws) if the DB is unreachable or errors out.
    bool Ping() const;

    // ── Write API ────────────────────────────────────────────────────────────

    // Atomically upsert artists, songs, credits and advance fetch_state.
    // Uses INSERT ... ON CONFLICT DO NOTHING for credits so concurrent
    // writers are safe. Only advances depth if new_depth > current depth(L1).
    void UpsertArtistSongs(const ArtistSongs& data, Depth new_depth);

private:
    // Pimpl hides the Postgres driver types.
    struct Impl;
    std::unique_ptr<Impl> impl_;

    userver::engine::TaskProcessor& main_tp_;
    userver::engine::TaskWithResult<void> migration_task_;
};

} // namespace six_feat
