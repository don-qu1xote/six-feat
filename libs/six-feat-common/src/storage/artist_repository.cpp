// ════════════════════════════════════════════════════════════════════════════
// artist_repository.cpp  —  iteration 7
//
// [IDEA-42] Thin delegate to PersistentStore (L1). No application-level
// cache: Postgres buffer cache + read replica absorb the read load that the
// old L2 LRU used to serve, and the LRU/TTL desync bug class is gone with it.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/artist_repository.hpp"

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "schemas/components/artist_repository_schema.hpp"

namespace six_feat {

using namespace userver;

ArtistRepository::ArtistRepository(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : ComponentBase(config, context),
      store_(context.FindComponent<PersistentStore>())
{}

yaml_config::Schema ArtistRepository::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(kArtistRepositoryComponentSchema);
}

// ── GetArtistSongs ───────────────────────────────────────────────────────────
//
// [BUG-4] Atomically complete ArtistRef guarantee:
//   Every returned ArtistSongs has a properly populated seed.name.
//   If L1 has an entry with depth < want (partial), we still return seed info
//   from the stored artists row — never a half-empty ref with only an id.
//
// Step 1: L1 has adequate depth? → return.
// Step 2: L1 has partial data (depth < want)? → return partial + network_needed.
// Step 3: Neither → return empty + network_needed (seed populated from ref arg).

GetResult ArtistRepository::GetArtistSongs(const ArtistRef& ref,
                                            Depth want) const {
    // Step 1/2 — L1 (may suspend on Postgres I/O).
    if (auto l1 = store_.LoadArtistSongs(ref.id, want)) {
        const Depth have = store_.GetFetchDepth(ref.id);
        LOG_DEBUG() << "[Repo] L1 hit id=" << ref.id
                    << " depth=" << static_cast<int>(have);
        return {std::move(*l1), have, false};
    }

    // Step 2 — L1 has partial data at a lower depth.
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

    // Step 3 — completely unknown.
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
    return store_.LoadArtistRef(artist_id);
}

std::vector<CollabEdge>
ArtistRepository::Neighbours(std::int64_t artist_id,
                              const RoleMask& mask) const {
    return store_.LoadNeighbours(artist_id, mask);
}

Depth ArtistRepository::GetFetchDepth(std::int64_t artist_id) const {
    return store_.GetFetchDepth(artist_id);
}

std::vector<std::int64_t>
ArtistRepository::ListIncompleteArtists(Depth want, int limit, int offset) const {
    return store_.ListIncompleteArtists(want, limit, offset);
}

bool ArtistRepository::HasAny(std::int64_t id) const {
    return store_.GetFetchDepth(id) != Depth::None;
}

// ── WriteThrough ─────────────────────────────────────────────────────────────
//
// L1.UpsertArtistSongs uses MAX(depth, existing) — monotonically advancing.

void ArtistRepository::WriteThrough(const ArtistSongs& data, Depth new_depth) {
    store_.UpsertArtistSongs(data, new_depth);       // durable, may suspend
    LOG_DEBUG() << "[Repo] WriteThrough id=" << data.seed.id
                << " depth=" << static_cast<int>(new_depth)
                << " songs=" << data.songs.size();
}

} // namespace six_feat
