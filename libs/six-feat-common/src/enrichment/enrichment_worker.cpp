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

#include "enrichment/enrichment_worker.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/components/statistics_storage.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/utils/statistics/writer.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "schemas/components/enrichment_worker_schema.hpp"

namespace six_feat {

using namespace userver;

namespace {

// A non-positive queue capacity makes EnrichmentQueue::TryPush fail for
// every job, silently disabling the background deep-scan feature instead
// of surfacing a config mistake at startup.
int RequireNonNegative(std::string_view param, int value) {
    if (value < 0) {
        throw std::runtime_error(
            "enrichment-worker: " + std::string(param) +
            " must be non-negative, got " + std::to_string(value));
    }
    return value;
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Constructor / Destructor
// ════════════════════════════════════════════════════════════════════════════

EnrichmentWorker::EnrichmentWorker(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : ComponentBase(config, context),
      repo_(context.FindComponent<ArtistRepository>()),
      gateway_(context.FindComponent<GeniusGatewayClient>()),
      capacity_(static_cast<std::size_t>(RequireNonNegative(
          "queue-capacity", config["queue-capacity"].As<int>(1024)))),
      queue_(capacity_),
      bg_tp_(context.GetTaskProcessor("bg-enrichment")),
      drain_timeout_(RequireNonNegative(
          "drain-timeout-ms", config["drain-timeout-ms"].As<int>(5000)))
{
    // Only prepare state here — the worker coroutine must not start until
    // OnAllComponentsLoaded(), once every component is guaranteed to be
    // fully constructed.

    // [IDEA-27] Expose enrichment_queue depth and pending_ count on the
    // internal metrics endpoint (see static_config.yaml handler-server-monitor).
    auto& storage =
        context.FindComponent<components::StatisticsStorage>().GetStorage();
    statistics_holder_ = storage.RegisterWriter(
        "enrichment-worker",
        [this](utils::statistics::Writer& writer) { ExtendStatistics(writer); });
}

EnrichmentWorker::~EnrichmentWorker() {
    statistics_holder_.Unregister();

    // Stop accepting new jobs, but let WorkerLoop drain what's already
    // queued: EnrichmentQueue::Close() only flips a flag and wakes the
    // consumer — BlockingPop() keeps returning already-enqueued jobs until
    // the queue is empty, only then does it return nullopt.
    queue_.Close();

    if (task_.IsValid()) {
        task_.WaitFor(drain_timeout_);
        if (!task_.IsFinished()) {
            LOG_WARNING() << "[EnrichmentWorker] drain timeout ("
                          << drain_timeout_.count()
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
    // [IDEA-18] Reload artists interrupted mid-scan before the worker starts
    // consuming, so recovered ids are registered ahead of any concurrent
    // foreground request that might race EnqueueIfNeeded for the same id.
    RecoverPendingArtists();

    // Start the worker coroutine on the background task processor.
    task_ = utils::Async(bg_tp_, "enrichment-worker",
                         [this] { WorkerLoop(); });
    LOG_INFO() << "[EnrichmentWorker] started on bg-enrichment TP";
}

// ════════════════════════════════════════════════════════════════════════════
// RecoverPendingArtists — startup recovery from persistent state (IDEA-18)
// ════════════════════════════════════════════════════════════════════════════

void EnrichmentWorker::RecoverPendingArtists() {
    if (capacity_ == 0) return;

    constexpr int kBatchSize = 256;
    std::size_t recovered = 0;
    int offset = 0;
    while (recovered < capacity_) {
        const int limit = static_cast<int>(
            std::min<std::size_t>(kBatchSize, capacity_ - recovered));
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
        if (ids.size() < static_cast<std::size_t>(limit)) break; // last page
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

// ════════════════════════════════════════════════════════════════════════════
// EnqueueIfNeeded — called from CollabService (FG coroutine)
// ════════════════════════════════════════════════════════════════════════════

bool EnrichmentWorker::EnqueueIfNeeded(const ArtistRef& ref,
                                        const std::string& user_token) {
    // Skip if already at Full depth — nothing more to fetch.
    if (repo_.GetFetchDepth(ref.id) >= Depth::Full) return false;

    // [ТЗ-6] No server-level fallback token — without a user token the
    // worker has no credentials to call Genius with, so there is nothing
    // useful to enqueue. This should not normally happen since callers are
    // already authenticated by the time they reach EnqueueIfNeeded, but
    // guard against it explicitly rather than silently queuing a job that
    // can only ever fail.
    if (user_token.empty()) {
        LOG_WARNING() << "[EnrichmentWorker] refusing to enqueue artist "
                      << ref.id << " — no user token available";
        return false;
    }

    {
        std::unique_lock lock(pending_mu_);
        if (pending_.count(ref.id)) {
            // [IDEA-18] A hit here is either a job already in flight, or an
            // artist recovered from persistent state at startup that was
            // reserved but never pushed to queue_ (no token was available
            // then). Only the latter should proceed — erase() tells them
            // apart without a second lookup.
            if (recovered_awaiting_token_.erase(ref.id) == 0) return false;
        } else {
            pending_.insert(ref.id);
        }
    }

    EnrichmentJob job;
    job.artist_id  = ref.id;
    job.target     = Depth::Full;
    job.name       = ref.name;
    job.image      = ref.image;
    job.url        = ref.url;
    job.user_token = user_token;

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
                ref.id, limit, Lane::Background, job.user_token);

            // Step BG-6: fetch each song detail (BG lane, one at a time —
            // BG LaneSemaphore(1) ensures serial execution; BG TokenBucket
            // paces the interval).
            ArtistSongs full;
            full.seed = ref;
            full.songs.reserve(song_ids.size());
            bool all_details_ok = true;
            for (const auto sid : song_ids) {
                // Respect cancellation on shutdown.
                engine::current_task::CancellationPoint();
                if (auto rec = gateway_.FetchSongDetail(sid, Lane::Background,
                                                         job.user_token)) {
                    full.songs.push_back(std::move(*rec));
                } else {
                    all_details_ok = false;
                }
            }

            // Step BG-7: persist to L1 and warm L2. Only promote to
            // Depth::Full when every expected song detail was fetched —
            // otherwise the artist would be stuck at a terminal depth with
            // missing songs and never get re-enriched (EnqueueIfNeeded skips
            // anything already at Depth::Full).
            const bool scan_complete =
                all_details_ok && full.songs.size() == song_ids.size();
            if (scan_complete) {
                repo_.WriteThrough(full, Depth::Full);
                LOG_INFO() << "[EnrichmentWorker] completed artist " << ref.id
                           << " '" << ref.name << "'"
                           << " songs=" << full.songs.size();
            } else if (!full.songs.empty()) {
                // Partial data — persist what we have at Foreground depth so
                // it stays below the target and remains eligible for a
                // future re-enrichment attempt.
                repo_.WriteThrough(full, Depth::Foreground);
                LOG_WARNING() << "[EnrichmentWorker] partial scan for artist "
                              << ref.id << " '" << ref.name << "'"
                              << " songs=" << full.songs.size() << "/"
                              << song_ids.size()
                              << " — not promoting to Depth::Full";
            } else {
                LOG_WARNING() << "[EnrichmentWorker] no song details fetched "
                                 "for artist "
                              << ref.id << " '" << ref.name
                              << "' — leaving depth unchanged";
            }

        } catch (const GeniusHttpError& e) {
            if (e.status_code == 503) {
                LOG_WARNING() << "[EnrichmentWorker] CB open, re-enqueue artist "
                              << job.artist_id;
                // CB is open — back off and re-enqueue later.
                engine::InterruptibleSleepFor(std::chrono::seconds{30});
                // Re-enqueue only if still pending (don't accumulate duplicate jobs).
                {
                    std::unique_lock lock(pending_mu_);
                    if (pending_.count(job.artist_id)) {
                        if (!queue_.TryPush(job)) {
                            // Queue still full on retry — drop instead of
                            // leaving a stuck pending_ entry that would
                            // block all future re-enqueue attempts.
                            LOG_WARNING() << "[EnrichmentWorker] queue full "
                                             "on CB re-enqueue, dropping artist "
                                          << job.artist_id;
                            pending_.erase(job.artist_id);
                        }
                    }
                }
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
