#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "auth/oauth_handler.hpp"
#include "http/health_handler.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
    const auto component_list =
        components::MinimalServerComponentList()
            .Append<clients::dns::Component>()
            .AppendComponentList(clients::http::ComponentList())
            .Append<components::TestsuiteSupport>()
            .Append<six_feat::auth::OAuthConfig>()
            .Append<six_feat::auth::LoginHandler>()
            .Append<six_feat::auth::CallbackHandler>()
            .Append<six_feat::auth::LogoutHandler>()
            .Append<six_feat::auth::MeHandler>()
            .Append<six_feat::HealthHandler>()
            // [IDEA-27 pattern] Internal metrics endpoint — bound to
            // listener-monitor (see static_config.yaml), never on the
            // public listener.
            .Append<server::handlers::ServerMonitor>();

    return utils::DaemonMain(argc, argv, component_list);
}
