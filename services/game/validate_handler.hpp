#pragma once

// ════════════════════════════════════════════════════════════════════════════
// validate_handler.hpp — [SF-GAME-14] POST /api/v1/game/validate
//
// Server-side anti-cheat check for a submitted Connect-mode attempt: verifies
// every hop is a real collaboration (chain_validator.hpp, via six-feat's
// /internal/neighbours) and that the chain actually starts/ends at the given
// challenge endpoints. Never trusts anything the client claims about its own
// validity — the client only ever sends the raw chain of artist ids; this
// handler recomputes the verdict from scratch every time, ignoring any
// "valid"-shaped field the request body might otherwise carry.
//
// Body: {"from": <int64>, "to": <int64>, "chain": [<int64>, ...],
//        "role_mask"?: <int>}
// 200: {"valid": true}
//    | {"valid": false, "reason": "endpoint_mismatch"}
//    | {"valid": false, "reason": "invalid_hop", "invalid_hop_index": <int>}
// 400: malformed body / from,to missing or <=0 / chain shorter than 2
// 401: not authenticated (six_feat_session, see game_session.hpp)
// 503: six-feat's /internal/neighbours couldn't be reached — distinct from a
//      confirmed-invalid verdict, so a transient outage is never reported to
//      the player as "you cheated".
// ════════════════════════════════════════════════════════════════════════════

#include <array>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class NeighboursClient;

class ValidateHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-validate";

    ValidateHandler(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const NeighboursClient&        neighbours_;
    std::array<unsigned char, 32>  session_key_;
};

} // namespace six_feat::game
