#include <six-feat-core/fg_fanout_limiter.hpp>
#include <six-feat-enrichment/enrichment_worker.hpp>
#include <six-feat-enrichment/prune_task.hpp>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <six-feat-http/health_handler.hpp>
#include <six-feat-sources/genius_music_source_provider.hpp>
#include <six-feat-sources/music_source_provider_chain.hpp>
#include <six-feat-sources/yandex_music_source_provider.hpp>
#include <six-feat-storage/artist_repository.hpp>
#include <six-feat-storage/persistent_store.hpp>
#include <six-feat-yandex/yandex_gateway_client.hpp>
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "internal/enqueue_handler.hpp"
#include "internal/status_handler.hpp"
#include "system/readiness_handler.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
  const auto component_list = components::MinimalServerComponentList()
                                  .Append<clients::dns::Component>()
                                  .AppendComponentList(clients::http::ComponentList())
                                  .Append<components::TestsuiteSupport>()
                                  .Append<components::Postgres>("postgres-db-1")
                                  .Append<six_feat::PersistentStore>()
                                  .Append<six_feat::GeniusGatewayClient>()
                                  .Append<six_feat::FgFanoutLimiter>()
                                  .Append<six_feat::YandexGatewayClient>()
                                  .Append<six_feat::YandexMusicSourceProvider>()
                                  .Append<six_feat::GeniusMusicSourceProvider>()
                                  .Append<six_feat::MusicSourceProviderChain>()
                                  .Append<six_feat::ArtistRepository>()
                                  .Append<six_feat::EnrichmentWorker>()
                                  .Append<six_feat::PruneTask>()
                                  .Append<six_feat::enrichment::EnqueueHandler>()
                                  .Append<six_feat::enrichment::InternalStatusHandler>()
                                  .Append<six_feat::HealthHandler>()
                                  .Append<six_feat::enrichment::ReadinessHandler>()
                                  .Append<server::handlers::ServerMonitor>();

  return utils::DaemonMain(argc, argv, component_list);
}
