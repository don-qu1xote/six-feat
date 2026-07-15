#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "storage/artist_repository.hpp"
#include "enrichment/enrichment_worker.hpp"
#include "genius/genius_gateway_client.hpp"
#include "http/health_handler.hpp"
#include "storage/persistent_store.hpp"

#include "internal_handlers.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
    const auto component_list =
        components::MinimalServerComponentList()
            .Append<clients::dns::Component>()
            .AppendComponentList(clients::http::ComponentList())
            .Append<components::TestsuiteSupport>()
            .Append<components::Postgres>("postgres-db-1")
            .Append<six_feat::PersistentStore>()
            .Append<six_feat::GeniusGatewayClient>()
            .Append<six_feat::ArtistRepository>()
            .Append<six_feat::EnrichmentWorker>()
            .Append<six_feat::enrichment::EnqueueHandler>()
            .Append<six_feat::enrichment::InternalStatusHandler>()
            // [SF-INF-03] Shared liveness handler (six-feat-common) — was a
            // local HealthHandler reimplementation identical in every way
            // but its kName; now every service that has a /healthz uses
            // this exact same component. /readyz below stays
            // enrichment-specific (its checks differ per service).
            .Append<six_feat::HealthHandler>()
            .Append<six_feat::enrichment::ReadinessHandler>()
            // [IDEA-27] Internal metrics endpoint — bound to listener-monitor
            // (see static_config.yaml), never on the public :8081 listener.
            .Append<server::handlers::ServerMonitor>();

    return utils::DaemonMain(argc, argv, component_list);
}
