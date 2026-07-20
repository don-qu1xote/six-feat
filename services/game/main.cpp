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

#include "game_store.hpp"
#include "http/health_handler.hpp"
#include "internal_handlers.hpp"
#include "neighbours_client.hpp"
#include "profile_handler.hpp"
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
            // [IDEA-27 pattern] Internal metrics endpoint — bound to
            // listener-monitor (see static_config.yaml), never the public
            // listener.
            .Append<server::handlers::ServerMonitor>();

    return utils::DaemonMain(argc, argv, component_list);
}
