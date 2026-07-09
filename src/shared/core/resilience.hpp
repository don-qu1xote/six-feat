#pragma once

// ════════════════════════════════════════════════════════════════════════════
// resilience.hpp  —  iteration 6
//
// Extracts all resilience primitives from GeniusClient into a dedicated
// module and adds the lane concept (Foreground vs Background).
//
// Design principles (unchanged from iteration 5):
//   All primitives are userver-native (engine::Mutex, engine::Semaphore,
//   engine::ConditionVariable, engine::InterruptibleSleepFor) so that
//   coroutines park without blocking OS threads.
//
// New in iteration 6:
//   Lane — FG/BG split.  Each lane has its own TokenBucket and
//           LaneSemaphore.  CircuitBreaker and CooldownGate remain shared
//           because upstream health is global.
//
//   TokenBucket — proactive RPS cap per lane.
//                 FG: higher refill (e.g. 8/s, burst 8).
//                 BG: lower refill (e.g. 2/s, burst 2).
//                 Always combined with the reactive slot-gate (RateLimiter)
//                 so we never exceed the server's announced remaining quota.
//
//   ResiliencePipeline — RAII Guard that enforces the full acquisition
//                        order on entry and records outcome on destruction.
//
// Acquisition order (must be strictly respected to avoid priority inversion):
//   1. CircuitBreaker::AllowRequest()   — fast-fail if upstream is broken
//   2. CooldownGate::WaitForCooldown()  — park until 429 pause expires
//   3. TokenBucket[lane].Acquire()      — proactive RPS budget (our policy)
//   4. LaneSemaphore[lane].lock()       — concurrency cap per lane
//   5. RateLimiter::AcquireSlot()       — reactive server-announced remaining
// ════════════════════════════════════════════════════════════════════════════

#include <atomic>
#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>

#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/semaphore.hpp>

namespace six_feat {

// ── Lane ─────────────────────────────────────────────────────────────────────

enum class Lane { Foreground, Background };

// ── CooldownGate (shared; unchanged from iteration 5) ────────────────────────

class CooldownGate {
public:
    using Clock     = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;

    // Activate a global 429 cooldown until `deadline`.
    // No-op if cooldown is already active with a later deadline.
    void Activate(TimePoint deadline);

    // Park the calling coroutine until the cooldown expires.
    // Uses engine::ConditionVariable — never blocks an OS thread.
    void WaitForCooldown();

    bool IsActive() const;

private:
    mutable userver::engine::Mutex      mu_;
    userver::engine::ConditionVariable  cv_;
    TimePoint                           deadline_{};
    bool                                active_{false};
};

// ── RateLimiter — reactive slot-gate (shared; unchanged from iteration 5) ────

class RateLimiter {
public:
    static constexpr int kMinRemaining = 2;

    // Update from X-RateLimit-Remaining / X-RateLimit-Reset headers.
    // Wakes parked coroutines if new slots appeared.
    void Update(int remaining, std::int64_t reset_unix);

    // Atomically claim one slot; parks until one is available.
    void AcquireSlot();

    // Return a slot (on 429 / error, before headers are updated).
    void ReleaseSlot();

    int Remaining() const;

private:
    void WaitAndDecrement();

    mutable userver::engine::Mutex     mu_;
    userver::engine::ConditionVariable cv_;
    int          remaining_{-1};
    std::int64_t reset_unix_{0};
    int          available_slots_{-1};   // -1 = not yet initialised
};

// ── CircuitBreaker (shared; unchanged from iteration 5) ──────────────────────

class CircuitBreaker {
public:
    enum class State : int { Closed = 0, Open = 1, HalfOpen = 2 };

    explicit CircuitBreaker(int failure_threshold,
                            std::chrono::seconds open_duration)
        : failure_threshold_(failure_threshold),
          open_duration_(open_duration) {}

    bool  AllowRequest();
    void  RecordSuccess();
    void  RecordFailure();
    State CurrentState() const;

private:
    void Trip();
    void Reset();
    bool TryClaimProbe();  // HalfOpen: claim the single in-flight probe slot

    const int                  failure_threshold_;
    const std::chrono::seconds open_duration_;
    mutable std::mutex         mu_;      // no await under this lock — std::mutex is safe
    std::atomic<State>         state_{State::Closed};
    std::atomic<bool>          probe_in_flight_{false};  // HalfOpen: at most one probe
    int                        consecutive_failures_{0};
    std::chrono::steady_clock::time_point trip_time_{};
};

// ── TokenBucket — proactive RPS cap (per lane) ───────────────────────────────
//
// Classic token-bucket:
//   capacity  = burst size (max tokens)
//   refill_ns = nanoseconds per one token replenishment
//
// Acquire() atomically decrements; if empty, parks the coroutine until
// the next refill epoch (computed from last_refill_ + refill_ns_).
//
// Only engine:: primitives are used to avoid blocking OS threads.

class TokenBucket {
public:
    // tokens_per_sec: sustained rate; burst_size: maximum burst.
    TokenBucket(double tokens_per_sec, int burst_size);

    // Claim one token; park until one is available.
    void Acquire();

    // For testing / metrics.
    int AvailableTokens() const;

private:
    void Refill();     // call under mu_
    void WaitForToken();

    mutable userver::engine::Mutex     mu_;
    userver::engine::ConditionVariable cv_;

    const std::chrono::nanoseconds refill_ns_;   // time per token
    const int                      capacity_;     // burst
    double                         tokens_;       // current fill (fractional)
    std::chrono::steady_clock::time_point last_refill_;
};

// ── LaneConfig ───────────────────────────────────────────────────────────────

struct LaneConfig {
    double tokens_per_sec{8.0};
    int    burst{8};
    int    max_concurrent{3};
};

// ── ResiliencePipeline ───────────────────────────────────────────────────────
//
// Owns two lane-specific (TokenBucket + engine::Semaphore) pairs and
// the shared (CircuitBreaker + CooldownGate + RateLimiter).
//
// Usage:
//   auto guard = pipeline.Acquire(Lane::Foreground);   // blocks until all 5 steps pass
//   // ... send HTTP request ...
//   pipeline.OnResponse(guard, status_code, remaining_header, reset_header);
//   // guard destructs → releases semaphore slot and, as a safety net, any
//   // RateLimiter slot OnResponse() didn't already settle

class ResiliencePipeline {
public:
    ResiliencePipeline(LaneConfig fg, LaneConfig bg,
                       int cb_failure_threshold,
                       std::chrono::seconds cb_open_duration);

    // RAII guard returned by Acquire.
    // Always releases the semaphore slot on destruction, and releases the
    // RateLimiter slot too unless OnResponse() already settled it (CB
    // state is always updated explicitly via OnResponse / OnNetworkError).
    class Guard {
    public:
        Guard() = default;
        Guard(const Guard&) = delete;
        Guard& operator=(const Guard&) = delete;
        Guard(Guard&&) noexcept;
        Guard& operator=(Guard&&) noexcept;
        ~Guard();

    private:
        friend class ResiliencePipeline;
        explicit Guard(userver::engine::SemaphoreLock lock,
                       RateLimiter& rl);

        // Marks the RateLimiter slot as already accounted for (explicit
        // ReleaseSlot() or an absolute Update() from a present header) so
        // the destructor's safety-net release becomes a no-op.
        void MarkSlotSettled() noexcept { slot_settled_ = true; }

        userver::engine::SemaphoreLock sem_lock_;
        RateLimiter*                   rate_limiter_{nullptr};
        bool                           slot_settled_{false};
    };

    // Enforces the full 5-step acquisition order.
    // Throws six_feat::GeniusHttpError{503} if CB is Open (caller falls back to L1).
    Guard Acquire(Lane lane);

    // Call after every HTTP response. `guard` is the Guard returned by the
    // matching Acquire() call — OnResponse settles its RateLimiter slot
    // (explicit release or header-driven sync) so the Guard destructor
    // knows not to release it again.
    void OnResponse(Guard& guard,
                    int status_code,
                    int  remaining,        // from X-RateLimit-Remaining (-1 = absent)
                    std::int64_t reset_ts, // from X-RateLimit-Reset      ( 0 = absent)
                    std::chrono::seconds retry_after = std::chrono::seconds{60});

    // Call on network errors / exhausted retries.
    void OnNetworkError();

    CircuitBreaker::State CbState() const { return cb_.CurrentState(); }

    // [IDEA-27] Diagnostics consumed by GeniusGateway::ExtendStatistics for
    // the userver metrics endpoint — never used in the acquisition path
    // itself, so approximate/racy reads (RemainingApprox) are acceptable.
    int FgTokensAvailable() const { return fg_.bucket.AvailableTokens(); }
    int BgTokensAvailable() const { return bg_.bucket.AvailableTokens(); }
    int FgSlotsAvailable()  const { return static_cast<int>(fg_.semaphore.RemainingApprox()); }
    int BgSlotsAvailable()  const { return static_cast<int>(bg_.semaphore.RemainingApprox()); }

private:
    struct LaneData {
        TokenBucket               bucket;
        userver::engine::Semaphore semaphore;

        LaneData(LaneConfig cfg)
            : bucket(cfg.tokens_per_sec, cfg.burst),
              semaphore(static_cast<std::size_t>(cfg.max_concurrent)) {}
    };

    LaneData        fg_;
    LaneData        bg_;
    CircuitBreaker  cb_;
    CooldownGate    cooldown_;
    RateLimiter     rate_limiter_;
};

// ── GeniusHttpError (kept here for pipeline throws) ──────────────────────────

struct GeniusHttpError : std::runtime_error {
    int status_code;
    explicit GeniusHttpError(int code, const std::string& msg)
        : std::runtime_error(msg), status_code(code) {}
};

// ── Exponential backoff helper (free function) ────────────────────────────────

std::chrono::milliseconds ExponentialBackoff(int attempt,
                                             std::chrono::milliseconds base,
                                             std::chrono::milliseconds cap);

} // namespace six_feat
