#include "infrastructure/enrichment_client.hpp"

#include "schemas/components/enrichment_client_schema.hpp"

#include <algorithm>
#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/internal_http.hpp>
#include <six-feat-core/request_id.hpp>
#include <stdexcept>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/components/statistics_storage.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/utils/statistics/writer.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <utility>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("enrichment-client: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

}  // namespace
EnrichmentClient::EnrichmentClient(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      base_url_(config["enrichment-base-url"].As<std::string>()),
      shared_secret_(internal_api::SharedSecretFromEnv()),
      timeout_(std::chrono::milliseconds{
          RequirePositive("timeout-ms", config["timeout-ms"].As<int>(3000))}),
      retry_queue_capacity_(static_cast<std::size_t>(
          RequirePositive("retry-queue-capacity", config["retry-queue-capacity"].As<int>(256)))),
      retry_interval_(std::chrono::milliseconds{
          RequirePositive("retry-interval-ms", config["retry-interval-ms"].As<int>(15000))}),
      max_retry_age_(std::chrono::seconds{
          RequirePositive("max-retry-age-seconds", config["max-retry-age-seconds"].As<int>(900))}),
      enriching_cache_ttl_(std::chrono::milliseconds{RequirePositive(
          "enriching-cache-ttl-ms", config["enriching-cache-ttl-ms"].As<int>(3000))}),
      fs_tp_(context.GetTaskProcessor("fs-task-processor")) {
  auto& storage = context.FindComponent<components::StatisticsStorage>().GetStorage();
  statistics_holder_ = storage.RegisterWriter(
      "enrichment-client", [this](utils::statistics::Writer& writer) { ExtendStatistics(writer); });
}

EnrichmentClient::~EnrichmentClient() {
  statistics_holder_.Unregister();

  if (flush_task_.IsValid()) {
    flush_task_.RequestCancel();
    flush_task_.Wait();
  }
}

void EnrichmentClient::OnAllComponentsLoaded() {
  flush_task_ = utils::Async(fs_tp_, "enrichment-retry-flush", [this] { FlushLoop(); });
  LOG_INFO() << "[EnrichmentClient] retry-queue flusher started on "
                "fs-task-processor";
}

yaml_config::Schema EnrichmentClient::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kEnrichmentClientComponentSchema);
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
bool EnrichmentClient::SendEnqueueRequest(std::int64_t artist_id,
                                          const std::string& name,
                                          const std::string& image,
                                          const std::string& url,
                                          const std::string& user_token) const {
  try {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["artist_id"] = artist_id;
    b["name"] = name;
    b["image"] = image;
    b["url"] = url;
    b["user_token"] = user_token;

    const auto resp = internal_http::Post(http_client_,
                                          base_url_ + "/internal/enqueue",
                                          shared_secret_,
                                          formats::json::ToString(b.ExtractValue()),
                                          timeout_,
                                          CurrentRequestId());

    const int status = resp.status_code;
    if (status < 200 || status >= 300) {
      LOG_WARNING() << "[EnrichmentClient] enqueue artist " << artist_id << " failed: HTTP "
                    << status;
      return false;
    }
    return true;
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[EnrichmentClient] enqueue artist " << artist_id << " failed: " << ex.what();
    return false;
  }
}

void EnrichmentClient::EnqueueRetry(const ArtistRef& ref, const std::string& user_token) const {
  std::unique_lock lock(retry_mu_);

  for (const auto& job : retry_queue_) {
    if (job.artist_id == ref.id) {
      return;
    }
  }

  if (retry_queue_.size() >= retry_queue_capacity_) {
    LOG_WARNING() << "[EnrichmentClient] retry queue full (" << retry_queue_capacity_
                  << "), dropping oldest entry for artist " << retry_queue_.front().artist_id;
    retry_queue_.pop_front();
  }

  RetryJob job;
  job.artist_id = ref.id;
  job.name = ref.name;
  job.image = ref.image;
  job.url = ref.url;
  job.user_token = user_token;
  job.created_at = std::chrono::steady_clock::now();
  retry_queue_.push_back(std::move(job));

  LOG_WARNING() << "[EnrichmentClient] stashed artist " << ref.id
                << " in retry queue (size=" << retry_queue_.size() << ")";
}

void EnrichmentClient::ExtendStatistics(utils::statistics::Writer& writer) const {
  std::size_t size = 0;
  {
    std::unique_lock lock(retry_mu_);
    size = retry_queue_.size();
  }
  writer["retry_queue"]["size"] = size;
}

bool EnrichmentClient::EnqueueIfNeeded(const ArtistRef& ref, const std::string& user_token) const {
  if (SendEnqueueRequest(ref.id, ref.name, ref.image, ref.url, user_token)) {
    return true;
  }
  EnqueueRetry(ref, user_token);
  return false;
}

bool EnrichmentClient::FetchEnriching(std::int64_t artist_id) const {
  try {
    const auto resp =
        internal_http::Get(http_client_,
                           base_url_ + "/internal/status?id=" + std::to_string(artist_id),
                           shared_secret_,
                           timeout_,
                           CurrentRequestId());

    if (resp.status_code < 200 || resp.status_code >= 300) {
      LOG_WARNING() << "[EnrichmentClient] status artist " << artist_id << ": HTTP "
                    << resp.status_code;
      return false;
    }
    return formats::json::FromString(resp.body)["enriching"].As<bool>(false);
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[EnrichmentClient] status artist " << artist_id << " failed: " << ex.what();
    return false;
  }
}

void EnrichmentClient::PruneEnrichingCacheLocked() const {
  if (enriching_cache_.size() < kEnrichingCacheCapacity) return;

  std::vector<std::pair<std::int64_t, std::chrono::steady_clock::time_point>> entries;
  entries.reserve(enriching_cache_.size());
  for (const auto& [id, entry] : enriching_cache_) {
    entries.emplace_back(id, entry.fetched_at);
  }
  std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) {
    return a.second < b.second;
  });

  const std::size_t to_evict = entries.size() - kEnrichingCacheCapacity / 2;
  for (std::size_t i = 0; i < to_evict; ++i) {
    enriching_cache_.erase(entries[i].first);
  }
}

bool EnrichmentClient::IsEnriching(std::int64_t artist_id) const {
  const auto now = std::chrono::steady_clock::now();

  {
    std::unique_lock lock(enriching_cache_mu_);
    const auto it = enriching_cache_.find(artist_id);
    if (it != enriching_cache_.end() && now - it->second.fetched_at < enriching_cache_ttl_) {
      return it->second.enriching;
    }
  }

  const bool enriching = FetchEnriching(artist_id);

  std::unique_lock lock(enriching_cache_mu_);
  PruneEnrichingCacheLocked();
  enriching_cache_[artist_id] = EnrichingCacheEntry{enriching, std::chrono::steady_clock::now()};
  return enriching;
}

void EnrichmentClient::FlushLoop() {
  LOG_INFO() << "[EnrichmentClient] retry-queue flusher loop started";
  while (!engine::current_task::ShouldCancel()) {
    engine::InterruptibleSleepFor(retry_interval_);
    if (engine::current_task::ShouldCancel()) break;

    std::vector<RetryJob> snapshot;
    {
      std::unique_lock lock(retry_mu_);
      snapshot.assign(retry_queue_.begin(), retry_queue_.end());
    }
    if (snapshot.empty()) continue;

    const auto now = std::chrono::steady_clock::now();
    std::vector<std::int64_t> to_remove;
    for (const auto& job : snapshot) {
      engine::current_task::CancellationPoint();

      if (now - job.created_at >= max_retry_age_) {
        LOG_WARNING() << "[EnrichmentClient] dropping stale retry job "
                         "for artist "
                      << job.artist_id << " (exceeded max-retry-age)";
        to_remove.push_back(job.artist_id);
        continue;
      }

      if (SendEnqueueRequest(job.artist_id, job.name, job.image, job.url, job.user_token)) {
        LOG_INFO() << "[EnrichmentClient] retry succeeded for artist " << job.artist_id;
        to_remove.push_back(job.artist_id);
      }
    }

    if (!to_remove.empty()) {
      std::unique_lock lock(retry_mu_);
      for (const auto id : to_remove) {
        auto it = std::find_if(retry_queue_.begin(), retry_queue_.end(), [id](const RetryJob& j) {
          return j.artist_id == id;
        });
        if (it != retry_queue_.end()) retry_queue_.erase(it);
      }
    }
  }
  LOG_INFO() << "[EnrichmentClient] retry-queue flusher loop exiting";
}

}  // namespace six_feat