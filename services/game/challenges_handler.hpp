#pragma once

// ════════════════════════════════════════════════════════════════════════════
// challenges_handler.hpp — [game #3] GET /api/v1/game/challenges
//
// The challenge-browser window (front/src/game/game-windows.js): recent
// PLAYABLE challenges (ideal already computed), newest first, endpoints
// resolved to names/images so a card renders without a second round-trip, and
// one click starts the challenge. Reads game_challenges + six-feat's own
// artists table directly through GameStore::ListChallenges (same "shared
// Postgres, legit direct read" posture as GetLatestDailyChallenge).
//
// GET /api/v1/game/challenges?kind=<daily|custom>?&cursor=<opaque>?&limit=<int>?
//   200: {"challenges": [{"id","kind","optimal_len","created_ts",
//                         "from":{"id","name","image"?},
//                         "to":{"id","name","image"?}}, ...],
//         "next_cursor": "<created_ts>:<id>" | null}
//   400: unknown kind, or a non-numeric/out-of-range limit, or a malformed
//        cursor
//
// Keyset pagination on (created_ts, id) DESC — pass a page's next_cursor back
// as ?cursor= for the following page; omit it for the newest page. Open (no
// session), same posture as leaderboard_handler.hpp.
// ════════════════════════════════════════════════════════════════════════════

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;

class ChallengesHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-challenges";

    ChallengesHandler(const userver::components::ComponentConfig&  config,
                      const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const GameStore& store_;
};

} // namespace six_feat::game
