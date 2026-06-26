// ════════════════════════════════════════════════════════════════════════════
// resilience.cpp  —  iteration 6
//
// Implementations of CooldownGate, RateLimiter, CircuitBreaker,
// TokenBucket, and ResiliencePipeline.
//
// Everything from genius_client.cpp's resilience section is moved here
// verbatim (CooldownGate, RateLimiter, CircuitBreaker, ExponentialBackoff),
// then extended with TokenBucket and ResiliencePipeline.
//
// Coroutine safety rules (invariants enforced throughout):
//   • std::mutex is used ONLY when there is no coroutine suspend point
//     under the lock (CircuitBreaker, LruCache — identical to iteration 5).
//   • engine::Mutex is used whenever the critical section contains an await
//     (ConditionVariable::Wait/WaitUntil, InterruptibleSleepFor, I/O).
//   • engine::Semaphore parks coroutines without blocking OS threads.
// ════════════════════════════════════════════════════════════════════════════

#include "resilience.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <thread>

#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/semaphore.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/rand.hpp>

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// CooldownGate
// ════════════════════════════════════════════════════════════════════════════

void CooldownGate::Activate(TimePoint deadline) {
    std::unique_lock lock(mu_);
    if (active_ && deadline_ >= deadline) return;
    deadline_ = deadline;
    active_   = true;
    LOG_WARNING() << "[CooldownGate] Activated until "
                  << std::chrono::duration_cast<std::chrono::seconds>(
                         deadline.time_since_epoch()).count()
                  << " (monotonic ts)";
}

void CooldownGate::WaitForCooldown() {
    std::unique_lock lock(mu_);
    if (!active_) return;
    const auto deadline = deadline_;
    LOG_DEBUG() << "[CooldownGate] Coroutine waiting for cooldown end";
    cv_.WaitUntil(lock, deadline, [this, deadline] {
        return !active_ || deadline_ != deadline;
    });
    if (active_ && deadline_ == deadline) {
        active_ = false;
        LOG_INFO() << "[CooldownGate] Cooldown expired, releasing waiters";
        lock.unlock();
        cv_.NotifyAll();
    }
}

bool CooldownGate::IsActive() const {
    std::unique_lock lock(mu_);
    return active_ && (Clock::now() < deadline_);
}

// ════════════════════════════════════════════════════════════════════════════
// RateLimiter
// ════════════════════════════════════════════════════════════════════════════

void RateLimiter::Update(int remaining, std::int64_t reset_unix) {
    std::unique_lock lock(mu_);
    const bool slots_increased = (remaining >= 0) && (remaining > available_slots_);
    if (remaining >= 0) {
        remaining_       = remaining;
        available_slots_ = remaining;
    }
    if (reset_unix > 0) reset_unix_ = reset_unix;
    if (slots_increased) {
        lock.unlock();
        cv_.NotifyAll();
        LOG_DEBUG() << "[RateLimiter] Updated slots=" << remaining;
    }
}

void RateLimiter::AcquireSlot() {
    {
        std::unique_lock lock(mu_);
        if (available_slots_ < 0) return;  // not yet initialised — pass through
    }
    WaitAndDecrement();
}

void RateLimiter::ReleaseSlot() {
    std::unique_lock lock(mu_);
    if (available_slots_ < 0) return;
    ++available_slots_;
    lock.unlock();
    cv_.NotifyOne();
    LOG_DEBUG() << "[RateLimiter] Slot released, available=" << available_slots_;
}

int RateLimiter::Remaining() const {
    std::unique_lock lock(mu_);
    return remaining_;
}

void RateLimiter::WaitAndDecrement() {
    std::unique_lock lock(mu_);
    [[maybe_unused]] const bool notified = cv_.Wait(lock, [this] {
        return available_slots_ < 0 || available_slots_ > kMinRemaining;
    });
    if (available_slots_ < 0) return;
    --available_slots_;
    LOG_DEBUG() << "[RateLimiter] Slot acquired, available=" << available_slots_;
}

// ════════════════════════════════════════════════════════════════════════════
// CircuitBreaker
// ════════════════════════════════════════════════════════════════════════════

bool CircuitBreaker::AllowRequest() {
    const State s = state_.load(std::memory_order_acquire);
    if (s == State::Closed) return true;
    if (s == State::Open) {
        std::lock_guard lock(mu_);
        if (state_.load(std::memory_order_relaxed) != State::Open)
            return state_.load(std::memory_order_relaxed) == State::HalfOpen;
        if (std::chrono::steady_clock::now() - trip_time_ >= open_duration_) {
            LOG_INFO() << "[CB] Open→HalfOpen";
            state_.store(State::HalfOpen, std::memory_order_release);
            return true;
        }
        return false;
    }
    return true;  // HalfOpen: allow one probe
}

void CircuitBreaker::RecordSuccess() {
    const State s = state_.load(std::memory_order_acquire);
    if (s == State::Closed) {
        std::lock_guard lock(mu_);
        consecutive_failures_ = 0;
        return;
    }
    if (s == State::HalfOpen) {
        std::lock_guard lock(mu_);
        if (state_.load(std::memory_order_relaxed) == State::HalfOpen)
            Reset();
    }
}

void CircuitBreaker::RecordFailure() {
    std::lock_guard lock(mu_);
    ++consecutive_failures_;
    const State s = state_.load(std::memory_order_relaxed);
    if (s == State::HalfOpen) { Trip(); return; }
    if (s == State::Closed && consecutive_failures_ >= failure_threshold_) Trip();
}

CircuitBreaker::State CircuitBreaker::CurrentState() const {
    return state_.load(std::memory_order_acquire);
}

void CircuitBreaker::Trip() {
    trip_time_ = std::chrono::steady_clock::now();
    state_.store(State::Open, std::memory_order_release);
    LOG_ERROR() << "[CB] TRIPPED (failures=" << consecutive_failures_ << ")";
}

void CircuitBreaker::Reset() {
    consecutive_failures_ = 0;
    state_.store(State::Closed, std::memory_order_release);
    LOG_INFO() << "[CB] HalfOpen→Closed";
}

// ════════════════════════════════════════════════════════════════════════════
// TokenBucket
// ════════════════════════════════════════════════════════════════════════════
//
// Proactive per-lane RPS cap.  tokens_ is a double to allow fractional
// accumulation.  Acquire() always takes exactly 1.0 token.
//
// Refill is lazy (happens on Acquire, not on a timer) to avoid background
// threads; the steady-clock delta since last_refill_ determines how many
// tokens to add.
//
// Coroutine safety: engine::ConditionVariable::WaitUntil parks the coroutine
// (not the OS thread) until the next refill epoch.

TokenBucket::TokenBucket(double tokens_per_sec, int burst_size)
    : refill_ns_(static_cast<long long>(1e9 / tokens_per_sec)),
      capacity_(burst_size),
      tokens_(static_cast<double>(burst_size)),
      last_refill_(std::chrono::steady_clock::now()) {}

void TokenBucket::Refill() {
    // Called under mu_.
    const auto now  = std::chrono::steady_clock::now();
    const auto diff = now - last_refill_;
    if (diff < refill_ns_) return;
    const double new_tokens =
        static_cast<double>(diff.count()) /
        static_cast<double>(refill_ns_.count());
    tokens_ = std::min(static_cast<double>(capacity_),
                       tokens_ + new_tokens);
    last_refill_ = now;
}

void TokenBucket::Acquire() {
    std::unique_lock lock(mu_);
    while (true) {
        Refill();
        if (tokens_ >= 1.0) {
            tokens_ -= 1.0;
            return;
        }
        // Compute when the next token will be available.
        const auto deficit = 1.0 - tokens_;
        const auto wait_ns = static_cast<long long>(
            deficit * static_cast<double>(refill_ns_.count()));
        const auto wake_at = last_refill_ +
            std::chrono::nanoseconds{static_cast<long long>(
                static_cast<double>(refill_ns_.count()) * (1.0 - tokens_))} ;
        LOG_DEBUG() << "[TokenBucket] empty, parking coroutine for "
                    << wait_ns / 1000000 << " ms";
        // engine::ConditionVariable::WaitUntil parks coroutine only.
        cv_.WaitUntil(lock, wake_at, [this] {
            Refill();
            return tokens_ >= 1.0;
        });
    }
}

int TokenBucket::AvailableTokens() const {
    std::unique_lock lock(mu_);
    return static_cast<int>(tokens_);
}

// ════════════════════════════════════════════════════════════════════════════
// ResiliencePipeline::Guard
// ════════════════════════════════════════════════════════════════════════════

ResiliencePipeline::Guard::Guard(engine::SemaphoreLock lock,
                                  RateLimiter& rl)
    : sem_lock_(std::move(lock)), rate_limiter_(&rl) {}

ResiliencePipeline::Guard::Guard(Guard&& o) noexcept
    : sem_lock_(std::move(o.sem_lock_)),
      rate_limiter_(o.rate_limiter_)
{
    o.rate_limiter_ = nullptr;
}

ResiliencePipeline::Guard&
ResiliencePipeline::Guard::operator=(Guard&& o) noexcept {
    sem_lock_     = std::move(o.sem_lock_);
    rate_limiter_ = o.rate_limiter_;
    o.rate_limiter_ = nullptr;
    return *this;
}

ResiliencePipeline::Guard::~Guard() {
    // Semaphore slot released automatically via SemaphoreLock RAII.
    // RateLimiter slot is *not* released here: it was consumed by the request.
    // Release happens explicitly in OnResponse(429) / backoff loop.
}

// ════════════════════════════════════════════════════════════════════════════
// ResiliencePipeline
// ════════════════════════════════════════════════════════════════════════════

ResiliencePipeline::ResiliencePipeline(LaneConfig fg, LaneConfig bg,
                                       int cb_failure_threshold,
                                       std::chrono::seconds cb_open_duration)
    : fg_(fg), bg_(bg),
      cb_(cb_failure_threshold, cb_open_duration) {}

ResiliencePipeline::Guard ResiliencePipeline::Acquire(Lane lane) {
    // Step 1 — Circuit Breaker fast-fail.
    if (!cb_.AllowRequest())
        throw GeniusHttpError{503, "circuit breaker open"};

    // Step 2 — 429 cooldown (shared).
    cooldown_.WaitForCooldown();

    // Select the lane data.
    LaneData& ld = (lane == Lane::Foreground) ? fg_ : bg_;

    // Step 3 — Proactive token bucket (per lane).
    ld.bucket.Acquire();

    // Step 4 — Concurrency cap (per lane semaphore).
    engine::SemaphoreLock sem_lock{ld.semaphore};

    // Step 5 — Reactive slot gate (shared server quota).
    rate_limiter_.AcquireSlot();

    return Guard{std::move(sem_lock), rate_limiter_};
}

void ResiliencePipeline::OnResponse(int status_code,
                                     int  remaining,
                                     std::int64_t reset_ts,
                                     std::chrono::seconds retry_after) {
    // Update server quota regardless of status.
    rate_limiter_.Update(remaining, reset_ts);

    if (status_code == 429) {
        // Return the slot we just "used" — quota is exhausted.
        rate_limiter_.ReleaseSlot();

        using SC     = std::chrono::system_clock;
        using Steady = std::chrono::steady_clock;
        const auto now_unix = static_cast<std::int64_t>(
            std::chrono::duration_cast<std::chrono::seconds>(
                SC::now().time_since_epoch()).count());
        const std::int64_t wait_secs =
            (reset_ts > now_unix) ? (reset_ts - now_unix + 1)
                                  : retry_after.count();

        const auto deadline = Steady::now() + std::chrono::seconds{wait_secs};
        LOG_WARNING() << "[Pipeline] 429 — activating cooldown for "
                      << wait_secs << "s";
        cooldown_.Activate(deadline);
        // Caller sleeps via engine::InterruptibleSleepFor then retries.
        return;
    }

    if (status_code >= 200 && status_code < 300) {
        cb_.RecordSuccess();
    } else if (status_code >= 400 && status_code < 500) {
        // Client errors (not 429) don't count as upstream failures.
    } else {
        // 5xx or unexpected.
        cb_.RecordFailure();
    }
}

void ResiliencePipeline::OnNetworkError() {
    cb_.RecordFailure();
}

// ════════════════════════════════════════════════════════════════════════════
// ExponentialBackoff  [BUG-8 FIXED]
// ════════════════════════════════════════════════════════════════════════════
//
// Old code used a thread_local PRNG.  In userver's M:N coroutine model a
// coroutine can be rescheduled on a different OS thread between two
// suspension points, so "thread_local" really means "random OS thread's
// state" — different coroutines on the same thread share the generator,
// colliding their jitter windows and causing retry storms.
//
// Fix: use userver::utils::RandRange which maintains per-coroutine (not
// per-thread) PRNG state and is the idiomatic choice in userver for random
// numbers inside coroutines.  No seed management needed.

std::chrono::milliseconds ExponentialBackoff(int attempt,
                                             std::chrono::milliseconds base,
                                             std::chrono::milliseconds cap) {
    const int safe = std::min(attempt, 10);
    const long long base_delay = base.count() * (1LL << safe);

    // Coroutine-safe jitter via userver::utils::RandRange.
    // Range: [0, base_ms) so the jitter is at most one base interval.
    const std::int64_t jitter =
        (base.count() > 0)
            ? static_cast<std::int64_t>(
                  userver::utils::RandRange(
                      static_cast<std::uint64_t>(base.count())))
            : 0;

    const long long raw    = base_delay + jitter;
    const long long capped = std::min(raw, static_cast<long long>(cap.count()));
    return std::chrono::milliseconds{capped};
}

} // namespace six_feat
