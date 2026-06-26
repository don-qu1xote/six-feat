// ════════════════════════════════════════════════════════════════════════════
// enrichment_worker.cpp  —  iteration 6
//
// Background enrichment worker: pops jobs from EnrichmentQueue, fetches
// full song data (BG lane), and persists to L1 via ArtistRepository.
//
// The "plавное простреливание" (smooth drip) of the Genius API is achieved
// by the BG TokenBucket inside ResiliencePipeline: it refills at 2 tok/s
// and the BG LaneSemaphore limits concurrency to 1, so at most one request
// is in-flight at a time and the interval between calls is ≥ 0.5 s.
// ════════════════════════════════════════════════════════════════════════════

#include "enrichment_worker.hpp"

#include <chrono>
#include <optional>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// Constructor / Destructor
// ════════════════════════════════════════════════════════════════════════════

EnrichmentWorker::EnrichmentWorker(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : ComponentBase(config, context),
      repo_(context.FindComponent<ArtistRepository>()),
      gateway_(context.FindComponent<GeniusGateway>()),
      queue_(static_cast<std::size_t>(
          config["queue-capacity"].As<int>(1024)))
{
    auto& bg_tp = context.GetTaskProcessor("bg-enrichment");
    // Start the worker coroutine on the background task processor.
    task_ = utils::Async(bg_tp, "enrichment-worker",
                         [this] { WorkerLoop(); });
    LOG_INFO() << "[EnrichmentWorker] started on bg-enrichment TP";
}

EnrichmentWorker::~EnrichmentWorker() {
    queue_.Close();
    task_.RequestCancel();
    task_.Wait();
    LOG_INFO() << "[EnrichmentWorker] stopped";
}

yaml_config::Schema EnrichmentWorker::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(R"(
type: object
description: Background artist deep-scan worker
additionalProperties: false
properties:
    queue-capacity:
        type: integer
        description: Maximum pending enrichment jobs
        defaultDescription: '1024'
)");
}

// ════════════════════════════════════════════════════════════════════════════
// EnqueueIfNeeded — called from CollabService (FG coroutine)
// ════════════════════════════════════════════════════════════════════════════

bool EnrichmentWorker::EnqueueIfNeeded(const ArtistRef& ref) {
    // Skip if already at Full depth — nothing more to fetch.
    if (repo_.GetFetchDepth(ref.id) >= Depth::Full) return false;

    {
        std::unique_lock lock(pending_mu_);
        if (pending_.count(ref.id)) return false;   // already in-flight
        pending_.insert(ref.id);
    }

    EnrichmentJob job;
    job.artist_id = ref.id;
    job.target    = Depth::Full;
    job.name      = ref.name;
    job.image     = ref.image;
    job.url       = ref.url;

    if (!queue_.TryPush(std::move(job))) {
        // Queue is full — remove from pending set and drop.
        std::unique_lock lock(pending_mu_);
        pending_.erase(ref.id);
        LOG_WARNING() << "[EnrichmentWorker] queue full, dropping artist "
                      << ref.id;
        return false;
    }
    LOG_DEBUG() << "[EnrichmentWorker] enqueued artist " << ref.id
                << " '" << ref.name << "'";
    return true;
}

bool EnrichmentWorker::IsPending(std::int64_t id) const {
    std::unique_lock lock(pending_mu_);
    return pending_.count(id) > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// WorkerLoop — runs on bg-enrichment TP
// ════════════════════════════════════════════════════════════════════════════

void EnrichmentWorker::WorkerLoop() {
    LOG_INFO() << "[EnrichmentWorker] loop started";
    while (true) {
        // Step BG-1: park until a job is available (engine::CV, not OS block).
        auto job_opt = queue_.BlockingPop();
        if (!job_opt) {
            LOG_INFO() << "[EnrichmentWorker] queue closed, exiting";
            return;
        }
        const auto& job = *job_opt;

        // Step BG-3: check whether depth was already upgraded (e.g. by a
        // concurrent FG request that found a cache miss and fetched deeply).
        if (repo_.GetFetchDepth(job.artist_id) >= job.target) {
            LOG_DEBUG() << "[EnrichmentWorker] skip artist " << job.artist_id
                        << " already at target depth";
            std::unique_lock lock(pending_mu_);
            pending_.erase(job.artist_id);
            continue;
        }

        // Step BG-4: populate ArtistRef (use job metadata to avoid a lookup).
        ArtistRef ref;
        ref.id    = job.artist_id;
        ref.name  = job.name;
        ref.image = job.image;
        ref.url   = job.url;

        // If name is missing, resolve from repo (may be known from a FG scan).
        if (ref.name.empty()) {
            if (auto looked_up = repo_.Lookup(job.artist_id))
                ref = std::move(*looked_up);
        }

        try {
            // Step BG-5: fetch song list on BG lane.
            const int limit = gateway_.SongsLimitBg();
            const auto song_ids = gateway_.FetchSongList(
                ref.id, limit, Lane::Background);

            // Step BG-6: fetch each song detail (BG lane, one at a time —
            // BG LaneSemaphore(1) ensures serial execution; BG TokenBucket
            // paces the interval).
            ArtistSongs full;
            full.seed = ref;
            full.songs.reserve(song_ids.size());
            for (const auto sid : song_ids) {
                // Respect cancellation on shutdown.
                engine::current_task::CancellationPoint();
                if (auto rec = gateway_.FetchSongDetail(sid, Lane::Background))
                    full.songs.push_back(std::move(*rec));
            }

            // Step BG-7: persist to L1 and warm L2.
            repo_.WriteThrough(full, Depth::Full);
            LOG_INFO() << "[EnrichmentWorker] completed artist " << ref.id
                       << " '" << ref.name << "'"
                       << " songs=" << full.songs.size();

        } catch (const GeniusHttpError& e) {
            if (e.status_code == 503) {
                LOG_WARNING() << "[EnrichmentWorker] CB open, re-enqueue artist "
                              << job.artist_id;
                // CB is open — back off and re-enqueue later.
                engine::InterruptibleSleepFor(std::chrono::seconds{30});
                // Re-enqueue (don't erase from pending_ so dedupe still works).
                queue_.TryPush(job);
                continue;
            }
            LOG_WARNING() << "[EnrichmentWorker] HTTP error for artist "
                          << job.artist_id << ": " << e.what();
        } catch (const std::exception& ex) {
            LOG_WARNING() << "[EnrichmentWorker] error for artist "
                          << job.artist_id << ": " << ex.what();
        }

        // Step BG-8: remove from pending set (even on error — retry on next
        // request that needs this artist).
        {
            std::unique_lock lock(pending_mu_);
            pending_.erase(job.artist_id);
        }
    }
}

} // namespace six_feat
