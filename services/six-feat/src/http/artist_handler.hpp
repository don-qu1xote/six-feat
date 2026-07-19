#pragma once

// ════════════════════════════════════════════════════════════════════════════
// artist_handler.hpp
//
// ArtistHandler — artist metadata + fetch-state, L1/L2 only (SF-API-03).
//
// GET /api/v1/artist?id=<artist_id>
//   → 200 OK
//     { "id": 123, "name": "...", "image": "...", "url": "...",
//       "fetch_state": { "depth": 1, "song_count": 42,
//                         "last_fetch_ts": 1719400000 } }
//     ETag / Cache-Control (SF-API-04 pattern) — 304 on a matching
//     If-None-Match.
//   → 404 if the artist has no row in L1 (ArtistRepository::Lookup).
//
// "image"/"url" are omitted from the body when empty, same convention as
// graph_handler.cpp's node objects. "image" is whatever ArtistRef already
// carries — Genius's default-avatar placeholder is normalized to "" at
// ingest time (SF-API-07, genius_gateway.cpp's NormalizeArtistImageUrl),
// so no re-normalization happens here.
//
// Deliberately makes no Genius API calls of its own — every field comes
// from data already resident in L1 (ArtistRepository/PersistentStore).
// ════════════════════════════════════════════════════════════════════════════

#include "storage/artist_repository.hpp"
#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"
#include "storage/persistent_store.hpp"
#include "http/authenticated_handler_base.hpp"

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class ArtistHandler final : public AuthenticatedHandlerBase {
public:
    static constexpr std::string_view kName = "handler-artist";

    ArtistHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  ctx) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    ArtistRepository& repo_;
    PersistentStore&  store_;
};

} // namespace six_feat
