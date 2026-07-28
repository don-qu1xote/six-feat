#include "http/artist_handler.hpp"
#include "http/graph_handler.hpp"
#include "http/image_proxy_handler.hpp"
#include "http/internal_neighbours_handler.hpp"
#include "http/path_handler.hpp"
#include "http/readiness_handler.hpp"
#include "http/search_handler.hpp"
#include "http/sse_status_handler.hpp"
#include "http/static_handler.hpp"
#include "http/status_handler.hpp"

#include "auth/app_secret_parity_checker.hpp"

#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <six-feat-http/health_handler.hpp>
#include <six-feat-storage/artist_repository.hpp>
#include <six-feat-storage/persistent_store.hpp>
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "application/collab_service.hpp"
#include "infrastructure/enrichment_client.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
  const auto component_list = components::MinimalServerComponentList()
                                  .Append<clients::dns::Component>()
                                  .AppendComponentList(clients::http::ComponentList())
                                  .Append<components::TestsuiteSupport>()
                                  .Append<components::Postgres>("postgres-db-1")
                                  .Append<six_feat::PersistentStore>()
                                  .Append<six_feat::GeniusGatewayClient>()
                                  .Append<six_feat::auth::OAuthConfig>()
                                  .Append<six_feat::AppSecretParityChecker>()
                                  .Append<six_feat::ArtistRepository>()
                                  .Append<six_feat::EnrichmentClient>()
                                  .Append<six_feat::CollabService>()
                                  .Append<six_feat::RateLimitStoreComponent>()
                                  .Append<six_feat::GraphHandler>()
                                  .Append<six_feat::PathHandler>()
                                  .Append<six_feat::SearchHandler>()
                                  .Append<six_feat::HealthHandler>()
                                  .Append<six_feat::ReadinessHandler>()
                                  .Append<six_feat::StatusHandler>()
                                  .Append<six_feat::ArtistHandler>()
                                  .Append<six_feat::InternalNeighboursHandler>()
                                  .Append<six_feat::SseStatusHandler>()
                                  .Append<six_feat::ImageProxyHandler>()
                                  .Append<six_feat::IndexHandler>()
                                  .Append<six_feat::ScriptHandler>()
                                  .Append<six_feat::StyleHandler>()
                                  .Append<six_feat::VendorVisNetworkHandler>()
                                  .Append<six_feat::OpenApiHandler>()
                                  .Append<server::handlers::ServerMonitor>();

  return utils::DaemonMain(argc, argv, component_list);
}
