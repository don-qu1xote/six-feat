#pragma once

// ════════════════════════════════════════════════════════════════════════════
// season_handler.hpp — [game #4] GET /api/v1/game/season
//
// The Season & Achievements hub (front/src/game/game-windows.js): the current
// season (created on first sight via GameStore::EnsureCurrentSeason), its
// season-scoped podium (GetLeaderboard, kSeason), and the full achievement
// catalog (ListAchievementCatalog) — everything the hub needs in one call. The
// signed-in player's OWN earned badges are layered on client-side from
// /api/v1/game/profile, so this endpoint stays open (no session) and cacheable
// the same way the leaderboard is.
//
// GET /api/v1/game/season
//   200: {"season": {"id","name","starts_ts","ends_ts"},
//         "podium": [{"user_id","display_name","score","hops","ts"}, ...],
//         "achievements": [{"code","title","descr"}, ...]}
//
// Open (no session), same posture as leaderboard_handler.hpp /
// challenges_handler.hpp.
// ════════════════════════════════════════════════════════════════════════════

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;

class SeasonHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-season";

    SeasonHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const GameStore& store_;
};

} // namespace six_feat::game
