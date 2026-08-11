#include <six-feat-genius/genius_gateway.hpp>
#include <six-feat-http/health_handler.hpp>
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "internal/genius/artist_handler.hpp"
#include "internal/genius/candidates_handler.hpp"
#include "internal/genius/song_handler.hpp"
#include "internal/genius/song_list_handler.hpp"
#include "system/readiness_handler.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
  const auto component_list = components::MinimalServerComponentList()
                                  .Append<clients::dns::Component>()
                                  .AppendComponentList(clients::http::ComponentList())
                                  .Append<components::TestsuiteSupport>()
                                  .Append<six_feat::GeniusGateway>()
                                  .Append<six_feat::genius_gateway::ArtistHandler>()
                                  .Append<six_feat::genius_gateway::SongListHandler>()
                                  .Append<six_feat::genius_gateway::SongHandler>()
                                  .Append<six_feat::genius_gateway::CandidatesHandler>()
                                  .Append<six_feat::HealthHandler>()
                                  .Append<six_feat::genius_gateway::ReadinessHandler>()
                                  .Append<server::handlers::ServerMonitor>();

  return utils::DaemonMain(argc, argv, component_list);
}
