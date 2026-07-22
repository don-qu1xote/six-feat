#pragma once

// ════════════════════════════════════════════════════════════════════════════
// admin_handler.hpp — [admin] GET/POST /api/v1/game/admin — owner-gated ops.
//
// The game's tiny admin surface, embedded in the Profile window
// (front/src/game/game-windows.js): shows admin controls ONLY to the app
// owner. "Owner" is configured out-of-band via the admin-user-ids static-config
// field (populated from $game_admin_genius_ids → env GAME_ADMIN_GENIUS_IDS) —
// a comma-separated allowlist. Because the game session only ever carries the
// Genius USERNAME (game_session.hpp: user_id is a stable hash of that name, the
// service never sees Genius's numeric account id), each allowlist entry is
// matched against BOTH the username (case-insensitive) AND the derived user_id
// string, so an operator can list whichever they know. Empty allowlist (the
// default) means nobody is an admin — the panel simply never appears.
//
// GET /api/v1/game/admin
//   200: {"admin": true|false}   — is the caller (if any) an owner? A signed-
//        out caller is simply {admin:false}, not a 401 — this is a UI-gating
//        status probe, not a protected action.
//
// POST /api/v1/game/admin  (publish a daily challenge now)
//   Body: {"from"?: <int64>, "to"?: <int64>}  — a specific pair, or omit both
//         for a random interesting pair (same candidate pool the once-a-day
//         DailyChallengeTask draws from).
//   200: {"id","from","to","role_mask","kind":"daily","optimal_len"}
//   401: not authenticated
//   403: authenticated but not an owner
//   422: the chosen/selected pair isn't connected in L1 yet (no ideal path)
//   400: malformed body / from==to
//
// Gated the same way every write here is (ResolvePlayer over the six_feat_
// session), PLUS the owner allowlist check on top. Reuses NeighboursClient +
// the shared BFS (ideal_finder.hpp) and GameStore exactly as DailyChallengeTask
// does — publishing by hand is the same operation, just triggered on demand.
// ════════════════════════════════════════════════════════════════════════════

#include <array>
#include <string>
#include <string_view>
#include <vector>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;
class NeighboursClient;
struct Player;

class AdminHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-admin";

    AdminHandler(const userver::components::ComponentConfig&  config,
                 const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    bool IsAdmin(const Player& player) const;

    const GameStore&               store_;
    const NeighboursClient&        neighbours_;
    std::array<unsigned char, 32>  session_key_;
    // Each entry is a lowercased username OR a numeric user_id string; a player
    // is an admin if EITHER matches.
    std::vector<std::string>       admin_ids_;
};

} // namespace six_feat::game
