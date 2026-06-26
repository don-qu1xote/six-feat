// ════════════════════════════════════════════════════════════════════════════
// artist_repository.cpp  —  iteration 6
//
// Read-through: L2 LRU → L1 PersistentStore → network_needed signal.
// Write-through: L1 (durable) → then L2 warm.
//
// Coroutine notes:
//   • l2_ uses std::mutex — no suspend under its lock (same rule as before).
//   • store_.*() calls may suspend (SQLite offloaded to fs-blocking TP).
//     They are called WITHOUT any std::mutex held, so no blocking of the engine.
// ════════════════════════════════════════════════════════════════════════════

#include "artist_repository.hpp"

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

ArtistRepository::ArtistRepository(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : ComponentBase(config, context),
      store_(context.FindComponent<PersistentStore>()),
      l2_(
          static_cast<std::size_t>(
              config["l2-cache-max-artists"].As<int>(512)),
          std::chrono::seconds{
              config["l2-cache-ttl-seconds"].As<int>(1800)})
{}

yaml_config::Schema ArtistRepository::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(R"(
type: object
description: Two-level artist data cache (L2 LRU + L1 persistent store)
additionalProperties: false
properties:
    l2-cache-max-artists:
        type: integer
        description: L2 LRU capacity
        defaultDescription: '512'
    l2-cache-ttl-seconds:
        type: integer
        description: L2 entry TTL
        defaultDescription: '1800'
)");
}

// ── GetArtistSongs ───────────────────────────────────────────────────────────
//
// [BUG-4] Atomically complete ArtistRef guarantee:
//   Every returned ArtistSongs has a properly populated seed.name.
//   If L1 has an entry with depth < want (partial), we still return seed info
//   from the stored artists row — never a half-empty ref with only an id.
//
// Step 1: L2 hit with adequate depth?
// Step 2: L1 has adequate depth? → warm L2, return.
// Step 3: L1 has partial data (depth < want)? → return partial + network_needed.
// Step 4: Neither → return empty + network_needed (seed populated from ref arg).

GetResult ArtistRepository::GetArtistSongs(const ArtistRef& ref,
                                            Depth want) const {
    // Step 1 — L2 (hot path, no I/O).
    if (auto hit = l2_.Get(ref.id)) {
        if (hit->second >= want) {
            // [BUG-4] L2 entry always has a full seed (populated on Put).
            LOG_DEBUG() << "[Repo] L2 hit id=" << ref.id;
            return {std::move(hit->first), hit->second, false};
        }
    }

    // Step 2/3 — L1 (may suspend on SQLite I/O).
    // Try with exact depth first.
    if (auto l1 = store_.LoadArtistSongs(ref.id, want)) {
        const Depth have = store_.GetFetchDepth(ref.id);
        l2_.Put(ref.id, *l1, have);
        LOG_DEBUG() << "[Repo] L1 hit id=" << ref.id
                    << " depth=" << static_cast<int>(have);
        return {std::move(*l1), have, false};
    }

    // Step 3 — L1 has partial data at a lower depth.
    const Depth have = store_.GetFetchDepth(ref.id);
    if (have != Depth::None) {
        // [BUG-4] LoadArtistSongs(id, Depth::None) always returns a result
        // if depth != None, because the artist row exists.
        // This guarantees seed.name is populated from the stored artists row.
        if (auto partial = store_.LoadArtistSongs(ref.id, Depth::None)) {
            LOG_DEBUG() << "[Repo] L1 partial id=" << ref.id
                        << " have=" << static_cast<int>(have)
                        << " want=" << static_cast<int>(want);
            return {std::move(*partial), have, true};
        }
    }

    // Step 4 — completely unknown.
    // [BUG-4] Use the ArtistRef passed in (from the resolve step) so the
    // caller always has at minimum the name from the search result,
    // never a bare {id, "", "", ""}.
    LOG_DEBUG() << "[Repo] miss id=" << ref.id;
    ArtistSongs empty;
    empty.seed = ref;   // preserves name/image/url from the caller
    return {std::move(empty), Depth::None, true};
}

std::optional<ArtistRef>
ArtistRepository::Lookup(std::int64_t artist_id) const {
    // Try L2 first (cheaper, no I/O).
    if (auto hit = l2_.GetStale(artist_id))
        return hit->first.seed;
    return store_.LoadArtistRef(artist_id);
}

std::vector<CollabEdge>
ArtistRepository::Neighbours(std::int64_t artist_id,
                              const RoleMask& mask) const {
    return store_.LoadNeighbours(artist_id, mask);
}

Depth ArtistRepository::GetFetchDepth(std::int64_t artist_id) const {
    // L2 shortcut — avoids a store round-trip for very hot nodes.
    if (auto hit = l2_.GetStale(artist_id))
        return hit->second;
    return store_.GetFetchDepth(artist_id);
}

bool ArtistRepository::HasAny(std::int64_t id) const {
    if (l2_.GetStale(id)) return true;
    return (store_.GetFetchDepth(id) != Depth::None);
}

// ── WriteThrough ─────────────────────────────────────────────────────────────
//
// L1 first (durable), then L2 (warm).
// L1.UpsertArtistSongs uses MAX(depth, existing) — monotonically advancing.

void ArtistRepository::WriteThrough(const ArtistSongs& data, Depth new_depth) {
    store_.UpsertArtistSongs(data, new_depth);       // durable, may suspend
    l2_.Put(data.seed.id, data, new_depth);          // warm cache
    LOG_DEBUG() << "[Repo] WriteThrough id=" << data.seed.id
                << " depth=" << static_cast<int>(new_depth)
                << " songs=" << data.songs.size();
}

} // namespace six_feat
