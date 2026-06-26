// ════════════════════════════════════════════════════════════════════════════
// main.cpp  —  iteration 6
//
// Component registration order follows the dependency graph:
//
//   PersistentStore   (no deps beyond http/dns)
//   GeniusGateway     (depends on HttpClient)
//   ArtistRepository  (depends on PersistentStore)
//   EnrichmentQueue   (no userver component deps — owned by EnrichmentWorker)
//   EnrichmentWorker  (depends on ArtistRepository + GeniusGateway)
//   CollabService     (depends on ArtistRepository + GeniusGateway +
//   EnrichmentWorker) Handlers          (depend on CollabService)
//
// userver resolves the DI graph automatically from kName strings in each
// component's GetStaticConfigSchema(); the order here is for readability.
//
// Task processors (declared in static_config.yaml):
//   main-task-processor   — foreground requests + handlers
//   bg-enrichment         — background deep-scan worker (low priority, 1
//   thread) fs-blocking           — SQLite blocking I/O offload (2 threads)
// ════════════════════════════════════════════════════════════════════════════

#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/utils/daemon_run.hpp>

#include "artist_repository.hpp"
#include "collab_service.hpp"
#include "enrichment_worker.hpp"
#include "genius_gateway.hpp"
#include "graph_handler.hpp"
#include "path_handler.hpp"
#include "persistent_store.hpp"
#include "static_handler.hpp"

using namespace userver;

int main(int argc, char *argv[]) {
  const auto component_list =
      components::MinimalServerComponentList()
          .Append<clients::dns::Component>()
          .Append<components::HttpClient>()
          // L1 store — must be first (no deps).
          .Append<six_feat::PersistentStore>()
          // Network layer (depends on HttpClient only).
          .Append<six_feat::GeniusGateway>()
          // L2+L1 repository (depends on PersistentStore).
          .Append<six_feat::ArtistRepository>()
          // Background subsystem (depends on ArtistRepository + GeniusGateway).
          .Append<six_feat::EnrichmentWorker>()
          // Orchestration (depends on repo + gateway + worker).
          .Append<six_feat::CollabService>()
          // HTTP handlers (depend on CollabService only).
          .Append<six_feat::GraphHandler>()
          .Append<six_feat::PathHandler>()
          // Static file handlers (no deps).
          .Append<six_feat::IndexHandler>()
          .Append<six_feat::ScriptHandler>();

  return utils::DaemonMain(argc, argv, component_list);
}
