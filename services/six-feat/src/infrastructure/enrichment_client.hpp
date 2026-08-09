#pragma once

#include <chrono>
#include <cstdint>
#include <deque>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <string_view>
#include <unordered_map>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/utils/statistics/entry.hpp>
#include <userver/utils/statistics/fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class EnrichmentClient final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "enrichment-client";

  EnrichmentClient(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  ~EnrichmentClient() override;

  void OnAllComponentsLoaded() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

  bool EnqueueIfNeeded(const ArtistRef& ref, const std::string& user_token) const;

  bool IsEnriching(std::int64_t artist_id) const;

 private:
  struct RetryJob {
    std::int64_t artist_id{0};
    std::string name;
    std::string image;
    std::string url;
    std::string user_token;
    std::chrono::steady_clock::time_point created_at;
  };

  struct EnrichingCacheEntry {
    bool enriching{false};
    std::chrono::steady_clock::time_point fetched_at;
  };

  bool FetchEnriching(std::int64_t artist_id) const;

  void PruneEnrichingCacheLocked() const;

  bool SendEnqueueRequest(std::int64_t artist_id,
                          const std::string& name,
                          const std::string& image,
                          const std::string& url,
                          const std::string& user_token) const;

  void EnqueueRetry(const ArtistRef& ref, const std::string& user_token) const;

  void FlushLoop();

  void ExtendStatistics(userver::utils::statistics::Writer& writer) const;

  userver::clients::http::Client& http_client_;
  const std::string base_url_;
  const std::string shared_secret_;
  const std::chrono::milliseconds timeout_;

  const std::size_t retry_queue_capacity_;
  const std::chrono::milliseconds retry_interval_;
  const std::chrono::seconds max_retry_age_;

  const std::chrono::milliseconds enriching_cache_ttl_;
  static constexpr std::size_t kEnrichingCacheCapacity = 4096;

  userver::engine::TaskProcessor& fs_tp_;

  mutable userver::engine::Mutex retry_mu_;
  mutable std::deque<RetryJob> retry_queue_;

  mutable userver::engine::Mutex enriching_cache_mu_;
  mutable std::unordered_map<std::int64_t, EnrichingCacheEntry> enriching_cache_;

  userver::engine::TaskWithResult<void> flush_task_;

  userver::utils::statistics::Entry statistics_holder_;
};

}  // namespace six_feat