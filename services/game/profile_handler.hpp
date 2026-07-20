#pragma once

// ════════════════════════════════════════════════════════════════════════════
// profile_handler.hpp — [SF-GAME-12] GET/PATCH /api/v1/game/profile.
//
// One handler serving both methods (static_config `method: GET, PATCH`,
// branched on request.GetMethod()):
//   GET   — the caller's own profile {user_id, display_name, elo, games, rank};
//           the row is created on first sight (EnsureAndGetProfile).
//           [SF-GAME-17] GET ?user=<int64> instead looks up ANOTHER
//           player's profile, read-only (never creates a row) and PUBLIC
//           (no session required — same posture as challenge_handler.hpp's
//           GET/leaderboard_handler.hpp: reading isn't an action that needs
//           to know who's asking). Adds a "history" array (their most
//           recent attempts, valid or not) that self-profile GET doesn't
//           carry. 404 if that user_id has no profile.
//   PATCH — change display_name (length + censorship validation); persists and
//           returns the refreshed profile. Always self — ?user= has no
//           effect here, PATCH always requires a session.
//
// Auth: the six_feat_session cookie is decrypted locally (game_session.hpp) —
// no HTTP to six-feat-auth. Anonymous self GET/PATCH (no/invalid cookie) →
// 401 in the unified RFC 7807 envelope (core/error_response.hpp, SF-API-11).
// Invalid display_name → 400 in the same envelope.
// ════════════════════════════════════════════════════════════════════════════

#include <array>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;

class ProfileHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-profile";

    ProfileHandler(const userver::components::ComponentConfig&  config,
                   const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const GameStore&               store_;
    std::array<unsigned char, 32>  session_key_;
};

} // namespace six_feat::game
