#pragma once

#include <chrono>
#include <cstdint>
#include <six-feat-common/music_source_provider.hpp>
#include <six-feat-enrichment/enrichment_queue.hpp>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <six-feat-sources/genius_music_source_provider.hpp>
#include <six-feat-storage/artist_repository.hpp>
#include <string>
#include <string_view>
#include <unordered_set>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/utils/statistics/entry.hpp>
#include <userver/utils/statistics/fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class EnrichmentWorker final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "enrichment-worker";

  EnrichmentWorker(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  ~EnrichmentWorker() override;

  void OnAllComponentsLoaded() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

  bool EnqueueIfNeeded(const ArtistRef& ref, const std::string& user_token);

  bool IsPending(std::int64_t id) const;

 private:
  void WorkerLoop();
  void RecoverPendingArtists();

  void ExtendStatistics(userver::utils::statistics::Writer& writer) const;

  ArtistRepository& repo_;
  GeniusGatewayClient& gateway_;
  GeniusMusicSourceProvider& source_;
  const std::size_t capacity_;
  EnrichmentQueue queue_;
  userver::engine::TaskProcessor& bg_tp_;

  const std::chrono::milliseconds drain_timeout_;

  mutable userver::engine::Mutex pending_mu_;
  std::unordered_set<std::int64_t> pending_;

  std::unordered_set<std::int64_t> recovered_awaiting_token_;

  userver::engine::TaskWithResult<void> task_;

  userver::utils::statistics::Entry statistics_holder_;
};

}  // namespace six_feat