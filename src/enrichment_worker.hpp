#pragma once

// ════════════════════════════════════════════════════════════════════════════
// enrichment_worker.hpp  —  iteration 6
//
// EnrichmentWorker is a long-lived userver component that runs a single
// background coroutine on the "bg-enrichment" task processor.
//
// Lifecycle:
//   OnAllComponentsLoaded()  → starts the worker coroutine via utils::Async
//                              on the bg-enrichment task processor.
//   OnAllComponentsAreStopping() / destructor
//                            → queue_.Close() → task_.RequestCancel()
//                                             → task_.Wait() (join)
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

#include "artist_repository.hpp"
#include "enrichment_queue.hpp"
#include "genius_gateway.hpp"

#include <cstdint>
#include <string_view>
#include <unordered_set>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class EnrichmentWorker final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "enrichment-worker";

    EnrichmentWorker(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    ~EnrichmentWorker() override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // Called by CollabService to request a background deep scan.
    // Returns true if the job was enqueued; false if already pending / full.
    bool EnqueueIfNeeded(const ArtistRef& ref);

    // Allow CollabService to check if an artist is pending.
    bool IsPending(std::int64_t id) const;

private:
    void WorkerLoop();    // runs on bg-enrichment TP

    ArtistRepository& repo_;
    GeniusGateway&    gateway_;
    EnrichmentQueue   queue_;

    // Deduplication set: artists currently enqueued or being processed.
    mutable userver::engine::Mutex            pending_mu_;
    std::unordered_set<std::int64_t>          pending_;

    userver::engine::TaskWithResult<void>     task_;
};

} // namespace six_feat
