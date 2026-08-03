
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/resilience.hpp>
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

void CooldownGate::Activate(TimePoint deadline) {
  std::unique_lock lock(mu_);
  if (active_ && deadline_ >= deadline) return;
  deadline_ = deadline;
  active_ = true;
  LOG_WARNING()
      << "[CooldownGate] request_id=" << CurrentRequestId() << " activated until "
      << std::chrono::duration_cast<std::chrono::seconds>(deadline.time_since_epoch()).count()
      << " (monotonic ts)";
}

void CooldownGate::WaitForCooldown() {
  std::unique_lock lock(mu_);
  if (!active_) return;
  const auto deadline = deadline_;
  LOG_DEBUG() << "[CooldownGate] Coroutine waiting for cooldown end";
  cv_.WaitUntil(lock, deadline, [this, deadline] { return !active_ || deadline_ != deadline; });
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

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void RateLimiter::Update(int remaining, std::int64_t reset_unix) {
  std::unique_lock lock(mu_);
  const bool slots_increased = (remaining >= 0) && (remaining > available_slots_);
  if (remaining >= 0) {
    remaining_ = remaining;
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
    if (available_slots_ < 0) return;
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
  [[maybe_unused]] const bool notified =
      cv_.Wait(lock, [this] { return available_slots_ < 0 || available_slots_ > kMinRemaining; });
  if (available_slots_ < 0) return;
  --available_slots_;
  LOG_DEBUG() << "[RateLimiter] Slot acquired, available=" << available_slots_;
}

bool CircuitBreaker::AllowRequest() {
  const State s = state_.load(std::memory_order_acquire);
  if (s == State::kClosed) return true;
  if (s == State::kHalfOpen) return TryClaimProbe();
  std::lock_guard lock(mu_);
  const State locked_state = state_.load(std::memory_order_relaxed);
  if (locked_state == State::kHalfOpen) return TryClaimProbe();
  if (locked_state != State::kOpen) return false;
  if (std::chrono::steady_clock::now() - trip_time_ >= open_duration_) {
    LOG_INFO() << "[CB] request_id=" << CurrentRequestId() << " Open→HalfOpen";
    state_.store(State::kHalfOpen, std::memory_order_release);
    probe_in_flight_.store(true, std::memory_order_release);
    return true;
  }
  return false;
}

bool CircuitBreaker::TryClaimProbe() {
  bool expected = false;
  return probe_in_flight_.compare_exchange_strong(expected, true, std::memory_order_acq_rel);
}

void CircuitBreaker::RecordSuccess() {
  const State s = state_.load(std::memory_order_acquire);
  if (s == State::kClosed) {
    std::lock_guard lock(mu_);
    consecutive_failures_ = 0;
    return;
  }
  if (s == State::kHalfOpen) {
    std::lock_guard lock(mu_);
    if (state_.load(std::memory_order_relaxed) == State::kHalfOpen) Reset();
  }
}

void CircuitBreaker::RecordFailure() {
  std::lock_guard lock(mu_);
  ++consecutive_failures_;
  const State s = state_.load(std::memory_order_relaxed);
  if (s == State::kHalfOpen) {
    Trip();
    return;
  }
  if (s == State::kClosed && consecutive_failures_ >= failure_threshold_) Trip();
}

CircuitBreaker::State CircuitBreaker::CurrentState() const {
  return state_.load(std::memory_order_acquire);
}

const char* CircuitBreaker::ToString(State state) {
  switch (state) {
    case State::kClosed:
      return "closed";
    case State::kOpen:
      return "open";
    case State::kHalfOpen:
      return "half_open";
  }
  return "unknown";
}

void CircuitBreaker::Trip() {
  trip_time_ = std::chrono::steady_clock::now();
  state_.store(State::kOpen, std::memory_order_release);
  probe_in_flight_.store(false, std::memory_order_release);
  LOG_ERROR() << "[CB] request_id=" << CurrentRequestId()
              << " TRIPPED (failures=" << consecutive_failures_ << ")";
}

void CircuitBreaker::Reset() {
  consecutive_failures_ = 0;
  state_.store(State::kClosed, std::memory_order_release);
  probe_in_flight_.store(false, std::memory_order_release);
  LOG_INFO() << "[CB] request_id=" << CurrentRequestId() << " HalfOpen→Closed";
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
TokenBucket::TokenBucket(double tokens_per_sec, int burst_size)
    : refill_ns_(static_cast<long long>(1e9 / tokens_per_sec)),
      capacity_(burst_size),
      tokens_(static_cast<double>(burst_size)),
      last_refill_(std::chrono::steady_clock::now()) {}

void TokenBucket::Refill() {
  const auto now = std::chrono::steady_clock::now();
  const auto diff = now - last_refill_;
  if (diff < refill_ns_) return;
  const double new_tokens =
      static_cast<double>(diff.count()) / static_cast<double>(refill_ns_.count());
  tokens_ = std::min(static_cast<double>(capacity_), tokens_ + new_tokens);
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
    const auto deficit = 1.0 - tokens_;
    const auto wait_ns = static_cast<long long>(deficit * static_cast<double>(refill_ns_.count()));
    const auto wake_at =
        last_refill_ + std::chrono::nanoseconds{static_cast<long long>(
                           static_cast<double>(refill_ns_.count()) * (1.0 - tokens_))};
    LOG_DEBUG() << "[TokenBucket] empty, parking coroutine for " << wait_ns / 1000000 << " ms";
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

ResiliencePipeline::Guard::Guard(engine::SemaphoreLock lock, RateLimiter& rl)
    : sem_lock_(std::move(lock)), rate_limiter_(&rl) {}

ResiliencePipeline::Guard::Guard(Guard&& o) noexcept
    : sem_lock_(std::move(o.sem_lock_)),
      rate_limiter_(o.rate_limiter_),
      slot_settled_(o.slot_settled_) {
  o.rate_limiter_ = nullptr;
}

ResiliencePipeline::Guard& ResiliencePipeline::Guard::operator=(Guard&& o) noexcept {
  if (this != &o) {
    if (rate_limiter_ && !slot_settled_) {
      rate_limiter_->ReleaseSlot();
    }
    sem_lock_ = std::move(o.sem_lock_);
    rate_limiter_ = o.rate_limiter_;
    slot_settled_ = o.slot_settled_;
    o.rate_limiter_ = nullptr;
  }
  return *this;
}

ResiliencePipeline::Guard::~Guard() {
  if (rate_limiter_ && !slot_settled_) {
    rate_limiter_->ReleaseSlot();
  }
}

ResiliencePipeline::ResiliencePipeline(LaneConfig fg,
                                       LaneConfig bg,
                                       int cb_failure_threshold,
                                       std::chrono::seconds cb_open_duration)
    : fg_(fg), bg_(bg), cb_(cb_failure_threshold, cb_open_duration) {}

ResiliencePipeline::Guard ResiliencePipeline::Acquire(Lane lane) {
  if (!cb_.AllowRequest()) throw GeniusHttpError{503, "circuit breaker open"};

  cooldown_.WaitForCooldown();

  LaneData& ld = (lane == Lane::kForeground) ? fg_ : bg_;

  ld.bucket.Acquire();

  engine::SemaphoreLock sem_lock{ld.semaphore};

  rate_limiter_.AcquireSlot();

  return Guard{std::move(sem_lock), rate_limiter_};
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void ResiliencePipeline::OnResponse(Guard& guard,
                                    int status_code,
                                    int remaining,
                                    std::int64_t reset_ts,
                                    std::chrono::seconds retry_after) {
  const bool had_remaining_header = remaining >= 0;

  rate_limiter_.Update(remaining, reset_ts);

  if (status_code == 429) {
    rate_limiter_.ReleaseSlot();
    guard.MarkSlotSettled();

    using SC = std::chrono::system_clock;
    using Steady = std::chrono::steady_clock;
    const auto now_unix = static_cast<std::int64_t>(
        std::chrono::duration_cast<std::chrono::seconds>(SC::now().time_since_epoch()).count());
    const std::int64_t wait_secs =
        (reset_ts > now_unix) ? (reset_ts - now_unix + 1) : retry_after.count();

    const auto deadline = Steady::now() + std::chrono::seconds{wait_secs};
    LOG_WARNING() << "[Pipeline] request_id=" << CurrentRequestId()
                  << " 429 — activating cooldown for " << wait_secs << "s";
    cooldown_.Activate(deadline);
    return;
  }

  if (!had_remaining_header) {
    rate_limiter_.ReleaseSlot();
  }
  guard.MarkSlotSettled();

  if (status_code >= 200 && status_code < 300) {
    cb_.RecordSuccess();
  } else if (status_code >= 400 && status_code < 500) {
  } else {
    cb_.RecordFailure();
  }
}

void ResiliencePipeline::OnNetworkError() {
  cb_.RecordFailure();
}

std::chrono::milliseconds ExponentialBackoff(int attempt,
                                             std::chrono::milliseconds base,
                                             std::chrono::milliseconds cap) {
  const int safe = std::min(attempt, 10);
  const long long base_delay = base.count() * (1LL << safe);

  const std::int64_t jitter =
      (base.count() > 0) ? static_cast<std::int64_t>(
                               userver::utils::RandRange(static_cast<std::uint64_t>(base.count())))
                         : 0;

  const long long raw = base_delay + jitter;
  const long long capped = std::min(raw, static_cast<long long>(cap.count()));
  return std::chrono::milliseconds{capped};
}

}  // namespace six_feat