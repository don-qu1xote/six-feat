
#include "schemas/components/enrichment_worker_schema.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <six-feat-enrichment/enrichment_worker.hpp>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <six-feat-sources/music_source_provider_chain.hpp>
#include <stdexcept>
#include <string>
#include <string_view>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/components/statistics_storage.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/utils/statistics/writer.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

int RequireNonNegative(std::string_view param, int value) {
  if (value < 0) {
    throw std::runtime_error("enrichment-worker: " + std::string(param) +
                             " must be non-negative, got " + std::to_string(value));
  }
  return value;
}

}  // namespace

EnrichmentWorker::EnrichmentWorker(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : ComponentBase(config, context),
      repo_(context.FindComponent<ArtistRepository>()),
      gateway_(context.FindComponent<GeniusGatewayClient>()),
      source_(context.FindComponent<MusicSourceProviderChain>()),
      capacity_(static_cast<std::size_t>(
          RequireNonNegative("queue-capacity", config["queue-capacity"].As<int>(1024)))),
      queue_(capacity_),
      bg_tp_(context.GetTaskProcessor("bg-enrichment")),
      drain_timeout_(
          RequireNonNegative("drain-timeout-ms", config["drain-timeout-ms"].As<int>(5000))) {
  auto& storage = context.FindComponent<components::StatisticsStorage>().GetStorage();
  statistics_holder_ = storage.RegisterWriter(
      "enrichment-worker", [this](utils::statistics::Writer& writer) { ExtendStatistics(writer); });
}

EnrichmentWorker::~EnrichmentWorker() {
  statistics_holder_.Unregister();

  queue_.Close();

  if (task_.IsValid()) {
    task_.WaitFor(drain_timeout_);
    if (!task_.IsFinished()) {
      LOG_WARNING() << "[EnrichmentWorker] drain timeout (" << drain_timeout_.count()
                    << "ms) exceeded, still processing (likely a slow "
                       "Genius request) — cancelling";
      task_.RequestCancel();
    }
    task_.Wait();
  }
  LOG_INFO() << "[EnrichmentWorker] stopped";
}

void EnrichmentWorker::ExtendStatistics(utils::statistics::Writer& writer) const {
  writer["queue"]["size"] = queue_.Size();

  std::size_t pending_count = 0;
  {
    std::unique_lock lock(pending_mu_);
    pending_count = pending_.size();
  }
  writer["pending"]["count"] = pending_count;
}

void EnrichmentWorker::OnAllComponentsLoaded() {
  try {
    RecoverPendingArtists();
  } catch (const std::exception& ex) {
    LOG_ERROR() << "[EnrichmentWorker] failed to recover pending artists "
                << "at startup (" << ex.what() << ") — continuing "
                << "without recovery, will retry naturally on restart";
  }

  task_ = utils::Async(bg_tp_, "enrichment-worker", [this] { WorkerLoop(); });
  LOG_INFO() << "[EnrichmentWorker] started on bg-enrichment TP";
}

void EnrichmentWorker::RecoverPendingArtists() {
  if (capacity_ == 0) return;

  constexpr int kBatchSize = 256;
  std::size_t recovered = 0;
  int offset = 0;
  while (recovered < capacity_) {
    const int limit = static_cast<int>(std::min<std::size_t>(kBatchSize, capacity_ - recovered));
    const auto ids = repo_.ListIncompleteArtists(Depth::Full, limit, offset);
    if (ids.empty()) break;

    {
      std::unique_lock lock(pending_mu_);
      for (const auto id : ids) {
        if (pending_.insert(id).second) {
          recovered_awaiting_token_.insert(id);
          ++recovered;
        }
      }
    }

    offset += static_cast<int>(ids.size());
    if (ids.size() < static_cast<std::size_t>(limit)) break;
  }

  if (recovered > 0) {
    LOG_INFO() << "[EnrichmentWorker] recovered " << recovered
               << " artist(s) at depth < Full from persistent state; "
                  "awaiting an authenticated request to resume each";
  }
}

yaml_config::Schema EnrichmentWorker::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kEnrichmentWorkerComponentSchema);
}

bool EnrichmentWorker::EnqueueIfNeeded(const ArtistRef& ref, const std::string& user_token) {
  if (repo_.GetFetchDepth(ref.id) >= Depth::Full) return false;

  if (user_token.empty()) {
    LOG_WARNING() << "[EnrichmentWorker] refusing to enqueue artist " << ref.id
                  << " — no user token available";
    return false;
  }

  {
    std::unique_lock lock(pending_mu_);
    if (pending_.count(ref.id)) {
      if (recovered_awaiting_token_.erase(ref.id) == 0) return false;
    } else {
      pending_.insert(ref.id);
    }
  }

  EnrichmentJob job;
  job.artist_id = ref.id;
  job.target = Depth::Full;
  job.name = ref.name;
  job.image = ref.image;
  job.url = ref.url;
  job.user_token = user_token;

  if (!queue_.TryPush(std::move(job))) {
    std::unique_lock lock(pending_mu_);
    pending_.erase(ref.id);
    LOG_WARNING() << "[EnrichmentWorker] queue full, dropping artist " << ref.id;
    return false;
  }
  LOG_DEBUG() << "[EnrichmentWorker] enqueued artist " << ref.id << " '" << ref.name << "'";
  return true;
}

bool EnrichmentWorker::IsPending(std::int64_t id) const {
  std::unique_lock lock(pending_mu_);
  return pending_.count(id) > 0;
}

void EnrichmentWorker::WorkerLoop() {
  LOG_INFO() << "[EnrichmentWorker] loop started";
  while (true) {
    auto job_opt = queue_.BlockingPop();
    if (!job_opt) {
      LOG_INFO() << "[EnrichmentWorker] queue closed, exiting";
      return;
    }
    const auto& job = *job_opt;

    if (repo_.GetFetchDepth(job.artist_id) >= job.target) {
      LOG_DEBUG() << "[EnrichmentWorker] skip artist " << job.artist_id
                  << " already at target depth";
      std::unique_lock lock(pending_mu_);
      pending_.erase(job.artist_id);
      continue;
    }

    ArtistRef ref;
    ref.id = job.artist_id;
    ref.name = job.name;
    ref.image = job.image;
    ref.url = job.url;

    if (ref.name.empty()) {
      if (auto looked_up = repo_.Lookup(job.artist_id)) ref = std::move(*looked_up);
    }

    try {
      const int limit = gateway_.SongsLimitBg();
      engine::current_task::CancellationPoint();

      // Тот же источник, что у дефолтного графа, но в background-полосе.
      auto full = source_.GetArtistSongs(ref, limit, Lane::Background, job.user_token);
      full.seed = ref;

      // Провайдер проглотил единичные сбои деталей внутри себя: отличить
      // частичный скан от полного здесь нельзя — повышаем непустую выборку.
      if (!full.songs.empty()) {
        repo_.WriteThrough(full, Depth::Full);
        LOG_INFO() << "[EnrichmentWorker] completed artist " << ref.id << " '" << ref.name << "'"
                   << " songs=" << full.songs.size();
      } else {
        LOG_WARNING() << "[EnrichmentWorker] no songs fetched for artist " << ref.id << " '"
                      << ref.name << "' — leaving depth unchanged";
      }

    } catch (const GeniusHttpError& e) {
      if (e.status_code == 503) {
        LOG_WARNING() << "[EnrichmentWorker] CB open, re-enqueue artist " << job.artist_id;
        engine::InterruptibleSleepFor(std::chrono::seconds{30});
        {
          std::unique_lock lock(pending_mu_);
          if (pending_.count(job.artist_id)) {
            if (!queue_.TryPush(job)) {
              LOG_WARNING() << "[EnrichmentWorker] queue full "
                               "on CB re-enqueue, dropping artist "
                            << job.artist_id;
              pending_.erase(job.artist_id);
            }
          }
        }
        continue;
      }
      LOG_WARNING() << "[EnrichmentWorker] HTTP error for artist " << job.artist_id << ": "
                    << e.what();
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[EnrichmentWorker] error for artist " << job.artist_id << ": " << ex.what();
    }

    {
      std::unique_lock lock(pending_mu_);
      pending_.erase(job.artist_id);
    }
  }
}

}  // namespace six_feat