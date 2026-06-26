#pragma once

// ════════════════════════════════════════════════════════════════════════════
// enrichment_queue.hpp  —  iteration 6
//
// Bounded coroutine-safe MPSC queue for background enrichment jobs.
//
// Producers (CollabService running on the main TP) call TryPush, which is
// non-blocking: it returns false immediately if the queue is full so the
// foreground request is never stalled.
//
// Consumer (EnrichmentWorker, one coroutine on bg-enrichment TP) calls
// BlockingPop which parks on engine::ConditionVariable when the queue is
// empty.  Only engine-native primitives are used so the OS thread is never
// blocked.
//
// Deduplication: CollabService maintains a separate pending_set (guarded by
// engine::Mutex) and only calls TryPush after inserting into the set.  The
// worker erases the entry after WriteThrough completes.  This prevents the
// same artist from accumulating multiple deep-scan jobs.
//
// Graceful shutdown:
//   Close() wakes the consumer with a closed sentinel.  After Close(),
//   BlockingPop returns an empty optional to signal the worker to exit.
// ════════════════════════════════════════════════════════════════════════════

#include "domain_types.hpp"

#include <cstddef>
#include <deque>
#include <optional>

#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>

namespace six_feat {

class EnrichmentQueue final {
public:
    explicit EnrichmentQueue(std::size_t capacity) : capacity_(capacity) {}

    // Non-blocking push.  Returns false if the queue is at capacity.
    // Safe to call from any coroutine on any task processor.
    bool TryPush(EnrichmentJob job);

    // Blocking pop (parks the calling coroutine, never blocks an OS thread).
    // Returns nullopt when the queue has been closed (shutdown signal).
    std::optional<EnrichmentJob> BlockingPop();

    // Signal shutdown.  Wakes the consumer so it can exit cleanly.
    void Close();

    std::size_t Size() const;
    bool        IsClosed() const;

private:
    const std::size_t               capacity_;
    std::deque<EnrichmentJob>       queue_;
    bool                            closed_{false};

    mutable userver::engine::Mutex     mu_;
    userver::engine::ConditionVariable cv_not_empty_;
};

} // namespace six_feat
