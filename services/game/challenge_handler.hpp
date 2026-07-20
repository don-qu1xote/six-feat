#pragma once

// ════════════════════════════════════════════════════════════════════════════
// challenge_handler.hpp — [SF-GAME-16] Challenge create/get.
//
// One handler serving both methods (static_config `method: GET, POST`,
// branched on request.GetMethod()), same shape as profile_handler.hpp:
//
// POST /api/v1/game/challenge
//   Body: {"from": <int64>, "to": <int64>, "role_mask"?: <int>}
//   Creates the (from, to, role_mask, kind="custom") challenge if it doesn't
//   already exist (UNIQUE constraint from SF-GAME-11), or returns the
//   existing one — a repeated create for the same triple always answers
//   with the same id. If the ideal hasn't been computed yet, computes it
//   now (ideal_finder.hpp's pure-L1 BFS, via six-feat's /internal/
//   neighbours) and caches it on the row before responding — "lazily", so
//   the (rare, once-per-distinct-pair) BFS cost is paid by whichever
//   create/get call happens to be first, not up front for every pair.
//   200: {"id", "from", "to", "role_mask", "kind", "optimal_len"}
//     — optimal_len is null if the BFS found nothing (yet); optimal_path
//     is NEVER included here — see GET below for why.
//   400: malformed body / from,to missing or <=0
//   401: not authenticated
//
// GET /api/v1/game/challenge?id=<int64>
//   Same body shape as POST's response, MINUS optimal_path — the ideal
//   route stays hidden until a real POST /api/v1/game/submit response
//   reveals it (submit_handler.cpp is the only place that ever happens).
//   Unlike this codebase's session-gated write endpoints, this read is
//   deliberately open (no six_feat_session required): fetching a
//   challenge's shape (not attempting it) doesn't need to know who's
//   asking, and a player should be able to load a challenge before
//   finishing sign-in.
//   200: {"id", "from", "to", "role_mask", "kind", "optimal_len"}
//   400: missing/non-numeric ?id=
//   404: no such challenge
//
// [fix] The ticket describes GET as "/api/v1/game/challenge/{id}" (a path
// parameter) — this codebase has no precedent anywhere for path-parameter
// routing (every existing read endpoint, e.g. handler-artist, handler-
// status, uses a `?id=` query parameter instead), so `?id=` was used here
// too for consistency with the rest of the API rather than introducing an
// unprecedented routing shape that can't be verified without a compiler in
// this environment.
// ════════════════════════════════════════════════════════════════════════════

#include <array>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;
class NeighboursClient;

class ChallengeHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-challenge";

    ChallengeHandler(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const GameStore&               store_;
    const NeighboursClient&        neighbours_;
    std::array<unsigned char, 32>  session_key_;
};

} // namespace six_feat::game
