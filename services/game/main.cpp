// ════════════════════════════════════════════════════════════════════════════
// six-feat-game — the fifth userver service. Competitive "connect two artists"
// game: players build a collaboration chain by hand and are scored against our
// own BFS ideal. It boots, answers GET /healthz and GET /readyz, and exposes
// the internal metrics listener. [SF-GAME-11] Now attaches the shared Postgres
// cluster and the game store that owns the game_* schema/migrations; the
// session-based profile lands in SF-GAME-12, the challenge/validation/scoring
// endpoints across sprint 13.
//
// Modeled on services/six-feat/src/main.cpp for the Postgres+store wiring and
// services/auth/main.cpp for the health/readiness/monitor from six_feat_common.
// Handlers and their wire format are shared code in libs/six-feat-common, not
// duplicated per service.
// ════════════════════════════════════════════════════════════════════════════
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "challenge_handler.hpp"
#include "core/rate_limit_store_component.hpp"
#include "daily_challenge_task.hpp"
#include "game_store.hpp"
#include "http/health_handler.hpp"
#include "internal_handlers.hpp"
#include "leaderboard_handler.hpp"
#include "neighbours_client.hpp"
#include "profile_handler.hpp"
#include "submit_handler.hpp"
#include "validate_handler.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
    const auto component_list =
        components::MinimalServerComponentList()
            .Append<clients::dns::Component>()
            .AppendComponentList(clients::http::ComponentList())
            .Append<components::TestsuiteSupport>()
            // [SF-GAME-13] Anti-cheat client: verifies a claimed hop A→B via
            // six-feat's internal /internal/neighbours (see
            // neighbours_client.hpp). Only needs the http-client above —
            // no Postgres/game-store dependency of its own.
            .Append<six_feat::game::NeighboursClient>()
            // [SF-GAME-11] Shared Postgres cluster (same postgres-db-1 the
            // other services use — game_* tables live in the same database)
            // and the game store that owns the game_* migration registry.
            .Append<components::Postgres>("postgres-db-1")
            .Append<six_feat::game::GameStore>()
            // [SF-GAME-17] Backend (single in-process, default | shared
            // Postgres-backed) for SubmitHandler's per-player rate limit —
            // reused as-is from six-feat's own SF-SEC-04 component. Must
            // come before SubmitHandler below, which looks it up in its own
            // constructor.
            .Append<six_feat::RateLimitStoreComponent>()
            .Append<six_feat::HealthHandler>()
            // [SF-INF-03] Unified readiness contract — /readyz now pings the
            // game store's Postgres cluster (see internal_handlers.cpp), the
            // service's one runtime-degradable dependency since SF-GAME-11.
            .Append<six_feat::game::ReadinessHandler>()
            // [SF-GAME-12] GET/PATCH /api/v1/game/profile — player profile
            // over the Genius session (decrypted locally, no HTTP to auth).
            .Append<six_feat::game::ProfileHandler>()
            // [SF-GAME-14] POST /api/v1/game/validate — server-side
            // anti-cheat chain check, needs NeighboursClient (already
            // appended above).
            .Append<six_feat::game::ValidateHandler>()
            // [SF-GAME-15] POST /api/v1/game/submit — scores a confirmed-
            // valid attempt against the challenge's own BFS ideal and
            // updates Elo; needs both GameStore and NeighboursClient
            // (already appended above).
            .Append<six_feat::game::SubmitHandler>()
            // [SF-GAME-16] POST/GET /api/v1/game/challenge — needs GameStore
            // and NeighboursClient (already appended above).
            .Append<six_feat::game::ChallengeHandler>()
            // [SF-GAME-16] Once-a-day publisher for kind="daily" challenges
            // — same dependencies as ChallengeHandler.
            .Append<six_feat::game::DailyChallengeTask>()
            // [SF-GAME-17] GET /api/v1/game/leaderboard — needs GameStore
            // (already appended above).
            .Append<six_feat::game::LeaderboardHandler>()
            // [IDEA-27 pattern] Internal metrics endpoint — bound to
            // listener-monitor (see static_config.yaml), never the public
            // listener.
            .Append<server::handlers::ServerMonitor>();

    return utils::DaemonMain(argc, argv, component_list);
}
