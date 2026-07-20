#pragma once

// ════════════════════════════════════════════════════════════════════════════
// leaderboard_handler.hpp — [SF-GAME-17] GET /api/v1/game/leaderboard
//
// Reads straight off game_attempts/game_profiles (GameStore::GetLeaderboard)
// — there is no separate leaderboard table to keep in sync; submit_handler's
// RecordValidAttempt writing the attempt row already IS the leaderboard
// update (see its own comment). One entry per player (their best valid
// attempt in scope), ranked by score descending.
//
// GET /api/v1/game/leaderboard?challenge_id=<int64>   (exactly one of these)
//                             |season_id=<int64>
//                             &cursor=<opaque string>?   (omit for page 1)
//                             &limit=<int>?               (default 20, 1..100)
//
// 200: {"entries": [{"user_id","display_name","score","hops","ts"}, ...],
//       "next_cursor": <string|null>}
// 400: neither/both of challenge_id and season_id given, or a non-numeric
//      id, or limit out of range
//
// Public — no session required (same posture as challenge_handler.hpp's
// GET, and for the same reason: reading a public leaderboard isn't an
// action that needs to know who's asking).
//
// [SF-PERF-06] Page 1 (no cursor) of each distinct (scope, id, limit) is
// cached in-process for cache-ttl-ms — the hot, repeatedly-requested slice
// (everyone loads a challenge's "top of the leaderboard" after finishing
// it); any page with a cursor bypasses the cache, since deep pages are both
// far less frequently requested and cheap to compute on demand. Per-process
// only, NOT shared/replicated across replicas — unlike the rate limiter
// (submit_handler.hpp), a slightly stale top-N view for up to cache-ttl-ms
// is a harmless, self-healing staleness window, not a correctness issue, so
// this doesn't need SF-SEC-04's Postgres-backed cross-replica machinery.
// ════════════════════════════════════════════════════════════════════════════

#include <chrono>
#include <string>
#include <string_view>
#include <unordered_map>

#include <userver/components/component_fwd.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;

class LeaderboardHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-leaderboard";

    LeaderboardHandler(const userver::components::ComponentConfig&  config,
                       const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    struct CacheEntry {
        std::string                           body;
        std::chrono::steady_clock::time_point expires_at;
    };

    const GameStore&                 store_;
    const std::chrono::milliseconds  cache_ttl_;

    mutable userver::engine::Mutex                        cache_mu_;
    mutable std::unordered_map<std::string, CacheEntry>   cache_;
};

} // namespace six_feat::game
