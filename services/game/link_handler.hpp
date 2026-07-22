#pragma once

// ════════════════════════════════════════════════════════════════════════════
// link_handler.hpp — [game #2] GET /api/v1/game/link — live per-hop check.
//
// The branching-web front-end (front/src/game/connect.js::isLinkedToFocus)
// calls this before letting a player TYPE an artist onto their web: is `to`
// actually a real one-hop collaborator of `from`? Frontier (dandelion) clicks
// skip it — those are already known collaborators — so this is only the typed/
// picked path's guard.
//
// GET /api/v1/game/link?from=<int64>&to=<int64>&roles=<mask>?
//   200: {"linked": true|false}     — a definitive verdict from L1
//   200: {"linked": null}           — the neighbours lookup couldn't be made
//                                      (six-feat unreachable); the client fails
//                                      OPEN, since submit still validates the
//                                      whole winning line server-side.
//   400: missing/non-numeric from or to
//
// Deliberately reports the "couldn't check" case as a 200 with linked:null
// rather than a 5xx: it isn't THIS service failing, it's a soft-degrade of the
// downstream anti-cheat lookup, and the front-end's three-state contract wants
// to tell "confirmed not linked" (block) apart from "couldn't ask" (allow).
// This is why it uses NeighboursClient::Neighbours (nullopt on failure vs a
// vector) directly, not the fail-closed IsRealHop convenience wrapper.
//
// Open (no session), same posture as challenge_handler.hpp's GET and
// leaderboard_handler.hpp: checking whether two artists collaborated is a
// public fact, not an action that needs to know who's asking.
// ════════════════════════════════════════════════════════════════════════════

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class NeighboursClient;

class LinkHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-link";

    LinkHandler(const userver::components::ComponentConfig&  config,
                const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const NeighboursClient& neighbours_;
};

} // namespace six_feat::game
