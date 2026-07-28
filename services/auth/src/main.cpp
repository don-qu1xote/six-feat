#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-http/health_handler.hpp>
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "internal_handlers.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
  const auto component_list = components::MinimalServerComponentList()
                                  .Append<clients::dns::Component>()
                                  .AppendComponentList(clients::http::ComponentList())
                                  .Append<components::TestsuiteSupport>()
                                  .Append<six_feat::auth::OAuthConfig>()
                                  .Append<six_feat::auth::LoginHandler>()
                                  .Append<six_feat::auth::CallbackHandler>()
                                  .Append<six_feat::auth::LogoutHandler>()
                                  .Append<six_feat::auth::MeHandler>()
                                  .Append<six_feat::HealthHandler>()
                                  .Append<six_feat::auth::ReadinessHandler>()
                                  .Append<six_feat::auth::KeyFingerprintHandler>()
                                  .Append<server::handlers::ServerMonitor>();

  return utils::DaemonMain(argc, argv, component_list);
}
