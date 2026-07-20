#pragma once

// ════════════════════════════════════════════════════════════════════════════
// submit_handler.hpp — [SF-GAME-15] POST /api/v1/game/submit
//
// Scores a completed attempt against a challenge's own BFS ideal and updates
// the player's Elo — see scoring.hpp for the score/Elo formulas and
// game_store.hpp's RecordValidAttempt/RecordInvalidAttempt for how they're
// persisted. Re-validates the submitted chain from scratch via
// chain_validator.hpp (SF-GAME-14) — this handler never trusts anything the
// client claims about its own chain's validity.
//
// Body: {"challenge_id": <int64>, "chain": [<int64>, ...], "elapsed_ms"?: <int>}
//
// 200 (chain confirmed real, scored, Elo updated):
//   {"valid": true, "player_len", "optimal_len", "optimal_path",
//    "score", "max_score", "elo_before", "elo_after", "elo_delta"}
//   — this is the ONLY place optimal_path (the hidden ideal) is ever sent to
//   the client; nothing before a real submit response can see it.
//
// 200 (chain rejected by chain_validator — recorded, but unscored):
//   {"valid": false, "reason": "endpoint_mismatch"}
//   {"valid": false, "reason": "invalid_hop", "invalid_hop_index": <int>}
//
// 400: malformed body / challenge_id missing / chain shorter than 2
// 401: not authenticated (six_feat_session)
// 404: no challenge with that id
// 409: challenge exists but its ideal hasn't been computed yet
//      (optimal_len is NULL — the challenge-creation flow, SF-GAME-16,
//      hasn't run for it) — nothing to score against, so this is refused
//      rather than silently scored as "infinitely bad".
// 429: this player is submitting faster than the per-player rate limit
//      allows (see rate_limit_ below) — [SF-GAME-17] anti-abuse, not
//      anti-cheat: chain_validator.hpp already rejects fabricated chains
//      regardless of how fast/slow they arrive; this just stops someone
//      from hammering the endpoint (e.g. to brute-force the prior_attempts
//      penalty window, or just to load-test the service by accident).
// 503: six-feat's /internal/neighbours couldn't be reached — distinct from
//      a confirmed-invalid verdict, same posture as validate_handler.cpp.
// ════════════════════════════════════════════════════════════════════════════

#include "core/rate_limiter.hpp"

#include <array>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;
class NeighboursClient;

class SubmitHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-game-submit";

    SubmitHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const GameStore&               store_;
    const NeighboursClient&        neighbours_;
    std::array<unsigned char, 32>  session_key_;
    // [SF-GAME-17] Per-player submit throttle. Backed by
    // RateLimitStoreComponent the same way six-feat's own GraphHandler/
    // PathHandler/SearchHandler are (SF-SEC-04) — reusing PerIpRateLimit
    // as-is (it's already keyed by an arbitrary caller-supplied string, not
    // literally an IP — see its own doc-comment) means this is
    // multi-replica-safe for free when the component's `backend: shared`
    // config points it at the same Postgres cluster every replica shares,
    // with zero new rate-limiting code.
    PerIpRateLimit rate_limit_;
};

} // namespace six_feat::game
