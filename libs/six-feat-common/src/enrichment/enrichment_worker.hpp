#pragma once

// ════════════════════════════════════════════════════════════════════════════
// enrichment_worker.hpp  —  iteration 6
//
// EnrichmentWorker is a long-lived userver component that runs a single
// background coroutine on the "bg-enrichment" task processor.
//
// Lifecycle:
//   OnAllComponentsLoaded()  → RecoverPendingArtists() reloads artists left
//                              at depth < Full by an interrupted run (IDEA-18),
//                              then starts the worker coroutine via
//                              utils::Async on the bg-enrichment task processor.
//   OnAllComponentsAreStopping() / destructor
//                            → queue_.Close() (stop accepting new jobs, but
//                              let BlockingPop drain what's already queued)
//                                             → task_.WaitFor(drain-timeout-ms)
//                                             → if still running: fallback to
//                                               task_.RequestCancel() + Wait()
//
// Startup recovery (IDEA-18):
//   Recovered artists have no user session to authenticate a Genius call
//   with, so they are NOT pushed onto the job queue directly — they are
//   only registered in pending_/recovered_awaiting_token_ (bounded by
//   queue-capacity, loaded in batches). EnqueueIfNeeded() treats a hit in
//   recovered_awaiting_token_ as "reactivate", not "duplicate": the first
//   real, authenticated request for that artist enqueues the actual job
//   with its token. If no such request ever arrives, the artist simply
//   stays un-enriched — no server-side fallback token is introduced.
//
// Worker loop (runs on bg-enrichment TP, low-priority):
//   1. BlockingPop() — park until a job arrives.
//   2. Check repo.GetFetchDepth(id) >= Full → skip (already done).
//   3. Resolve ArtistRef from repo.Lookup or use job.name/image/url directly.
//   4. gateway.FetchSongList(id, songs_limit_bg, BG lane).
//   5. For each song_id: gateway.FetchSongDetail(sid, BG lane).
//      (GeniusGateway::BG TokenBucket paces calls; no manual sleep needed.)
//   6. repo.WriteThrough(full_songs, Depth::Full).
//   7. pending_set_.erase(id) — see CollabService for the producer side.
//   8. goto 1.
//
// pending_set_ (engine::Mutex-guarded unordered_set<int64>) is shared with
// CollabService via EnqueueIfNeeded() so the same artist is never queued twice.
//
// Coroutine safety:
//   All primitives in the worker loop are coroutine-safe.
//   The BG TP uses InterruptibleSleepFor in backoff / TokenBucket so that
//   task cancellation (shutdown) wakes the worker immediately.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/artist_repository.hpp"
#include "enrichment/enrichment_queue.hpp"
#include "genius/genius_gateway_client.hpp"

#include <chrono>
#include <cstdint>
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

    EnrichmentWorker(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    ~EnrichmentWorker() override;

    // Starts the worker coroutine once every component is fully
    // constructed — must not start it from the constructor, since other
    // components (and this one) may not be safe to use yet.
    void OnAllComponentsLoaded() override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // Called by CollabService to request a background deep scan.
    // Returns true if the job was enqueued; false if already pending / full.
    // [ТЗ-6] user_token is the requesting user's Genius session token —
    // there is no server-level fallback for the worker to use anymore.
    bool EnqueueIfNeeded(const ArtistRef& ref, const std::string& user_token);

    // Allow CollabService to check if an artist is pending.
    bool IsPending(std::int64_t id) const;

private:
    void WorkerLoop();    // runs on bg-enrichment TP

    // Reloads artists with fetch_state.depth < Full from PersistentStore and
    // registers them for reactivation. Paginates in batches capped by
    // capacity_ so a large backlog can't blow up memory or overrun the
    // queue's configured capacity. Must run before the worker coroutine
    // starts consuming, and only touches in-memory bookkeeping — no jobs
    // are pushed onto queue_ here (no user token is available yet).
    void RecoverPendingArtists();

    // [IDEA-27] Exposes enrichment_queue size and pending_ count on the
    // internal metrics endpoint — see six_feat::GeniusGateway::ExtendStatistics
    // for the sibling registration pattern.
    void ExtendStatistics(userver::utils::statistics::Writer& writer) const;

    ArtistRepository&    repo_;
    GeniusGatewayClient& gateway_;
    const std::size_t    capacity_;
    EnrichmentQueue   queue_;
    userver::engine::TaskProcessor& bg_tp_;

    // How long the destructor waits for WorkerLoop to drain the remaining
    // queued jobs before falling back to RequestCancel().
    const std::chrono::milliseconds drain_timeout_;

    // Deduplication set: artists currently enqueued or being processed.
    mutable userver::engine::Mutex            pending_mu_;
    std::unordered_set<std::int64_t>          pending_;

    // Subset of pending_: artists recovered from persistent state at
    // startup that are reserved but have no job on queue_ yet, because
    // recovery has no user token to call Genius with. EnqueueIfNeeded()
    // erases an id from here (and pushes its job) the first time a real,
    // authenticated caller asks for that artist again.
    std::unordered_set<std::int64_t>          recovered_awaiting_token_;

    userver::engine::TaskWithResult<void>     task_;

    userver::utils::statistics::Entry         statistics_holder_;
};

} // namespace six_feat
