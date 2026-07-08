#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>   // вместо component.hpp
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "storage/artist_repository.hpp"
#include "auth/oauth_handler.hpp"
#include "core/collab_service.hpp"
#include "enrichment/enrichment_client.hpp"
#include "genius/genius_gateway_client.hpp"
#include "http/graph_handler.hpp"
#include "http/health_handler.hpp"
#include "http/path_handler.hpp"
#include "storage/persistent_store.hpp"
#include "http/readiness_handler.hpp"
#include "http/search_handler.hpp"
#include "http/static_handler.hpp"
#include "http/status_handler.hpp"
#include "http/sse_status_handler.hpp"

using namespace userver;

int main(int argc, char *argv[]) {
    const auto component_list =
        components::MinimalServerComponentList()
            .Append<clients::dns::Component>()
            .AppendComponentList(clients::http::ComponentList())
            .Append<components::TestsuiteSupport>()
            .Append<components::Postgres>("postgres-db-1")
            .Append<six_feat::PersistentStore>()
            .Append<six_feat::GeniusGatewayClient>()
            // [IDEA-53] OAuthConfig stays here — it's what
            // src/auth/token_router.hpp's RequireSession/ExtractToken use to
            // decrypt six_feat_session LOCALLY on every request (same
            // APP_SECRET the standalone six-feat-auth service encrypts with).
            // The OAuth flow itself (LoginHandler/CallbackHandler/
            // LogoutHandler/MeHandler) has moved to services/auth/ — see
            // that service's main.cpp.
            .Append<six_feat::auth::OAuthConfig>()
            .Append<six_feat::ArtistRepository>()
            .Append<six_feat::EnrichmentClient>()
            .Append<six_feat::CollabService>()
            .Append<six_feat::GraphHandler>()
            .Append<six_feat::PathHandler>()
            .Append<six_feat::SearchHandler>()
            .Append<six_feat::HealthHandler>()
            .Append<six_feat::ReadinessHandler>()
            .Append<six_feat::StatusHandler>()
            .Append<six_feat::SseStatusHandler>()
            .Append<six_feat::IndexHandler>()
            .Append<six_feat::ScriptHandler>()
            // [IDEA-27] Internal metrics endpoint — bound to listener-monitor
            // (see static_config.yaml), not the public listener.
            .Append<server::handlers::ServerMonitor>();

  return utils::DaemonMain(argc, argv, component_list);
}
