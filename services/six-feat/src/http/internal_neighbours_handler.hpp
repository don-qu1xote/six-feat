#pragma once

// ════════════════════════════════════════════════════════════════════════════
// internal_neighbours_handler.hpp — [SF-GAME-13]
//
// Internal-mesh endpoint six-feat-game calls to verify a claimed hop A→B is a
// REAL collaboration, without six-feat-game ever talking to Genius itself (it
// has no Genius credentials of its own) and without six-feat re-fetching
// anything it doesn't already have.
//
// POST /internal/neighbours   (X-Internal-Secret required — see
//                               core/internal_auth.hpp; the same shared
//                               secret genius-gateway's own internal API
//                               already reuses across the whole internal
//                               mesh, see that service's internal_handlers.hpp)
//   Body: {"artist_id": <int64>, "role_mask"?: <int, bitmask, default 15 =
//          all four roles: primary=1, producer=2, writer=4, featured=8 —
//          same encoding graph_handler.cpp's BuildGraphETag already uses>}
//   200: {"neighbours": [<int64>, ...]}
//   400: artist_id missing/<=0, or malformed JSON body
//   401: missing/wrong X-Internal-Secret
//
// Answers purely from L1 (ArtistRepository::Neighbours — the exact adjacency
// read CollabService::FindPath already uses to expand its BFS frontier), so
// this makes zero Genius calls of its own: an artist six-feat has never seen
// simply has an empty neighbour list here, same as FindPath would silently
// not expand through it. Never triggers the lazy foreground fetch
// GraphHandler/PathHandler perform — verifying a chain the player already
// built is not a reason to go fetch more data than we already lazily have.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/artist_repository.hpp"

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class InternalNeighboursHandler final
    : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-neighbours";

    InternalNeighboursHandler(const userver::components::ComponentConfig&  config,
                               const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    ArtistRepository& repo_;
    const std::string shared_secret_;
};

} // namespace six_feat
