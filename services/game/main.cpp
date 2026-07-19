// ════════════════════════════════════════════════════════════════════════════
// six-feat-game — the fifth userver service (SF-GAME-10). Competitive
// "connect two artists" game: players build a collaboration chain by hand and
// are scored against our own BFS ideal. This is the SF-GAME-10 skeleton only —
// it boots, answers GET /healthz and GET /readyz, and exposes the internal
// metrics listener. No game logic yet: the game_* store/migrations land in
// SF-GAME-11, the session-based profile in SF-GAME-12, the challenge/
// validation/scoring endpoints across sprint 13. The shared Postgres
// connection is plumbed through docker-entrypoint.sh/docker-compose.yml from
// this ticket (DSN assembled, dependency declared) so SF-GAME-11 only has to
// add the store component that reads it.
//
// Modeled on services/auth/main.cpp and services/genius-gateway/main.cpp:
// health/readiness/monitor from six_feat_common, no per-service Postgres
// component yet. Handlers and their wire format are shared code in
// libs/six-feat-common, not duplicated per service.
// ════════════════════════════════════════════════════════════════════════════
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "http/health_handler.hpp"
#include "internal_handlers.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
    const auto component_list =
        components::MinimalServerComponentList()
            .Append<clients::dns::Component>()
            // [SF-GAME-13] The http-client is wired from the skeleton on
            // purpose: sprint 13 adds outbound internal calls to six-feat
            // (/internal/neighbours anti-cheat, /api/v1/graph/path ideal) via
            // core/internal_http — keeping that a pure handler addition later,
            // not a components-manager change.
            .AppendComponentList(clients::http::ComponentList())
            .Append<components::TestsuiteSupport>()
            .Append<six_feat::HealthHandler>()
            // [SF-INF-03] Unified readiness contract — see
            // internal_handlers.hpp's ReadinessHandler doc-comment for why
            // this service's checks{} is empty at the skeleton stage (the
            // Postgres ping arrives with the store in SF-GAME-11).
            .Append<six_feat::game::ReadinessHandler>()
            // [IDEA-27 pattern] Internal metrics endpoint — bound to
            // listener-monitor (see static_config.yaml), never the public
            // listener.
            .Append<server::handlers::ServerMonitor>();

    return utils::DaemonMain(argc, argv, component_list);
}
