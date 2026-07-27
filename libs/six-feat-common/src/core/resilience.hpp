#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/semaphore.hpp>

namespace six_feat {

enum class Lane { Foreground, Background };

class CooldownGate {
 public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;

  void Activate(TimePoint deadline);

  void WaitForCooldown();

  bool IsActive() const;

 private:
  mutable userver::engine::Mutex mu_;
  userver::engine::ConditionVariable cv_;
  TimePoint deadline_{};
  bool active_{false};
};

class RateLimiter {
 public:
  static constexpr int kMinRemaining = 2;

  void Update(int remaining, std::int64_t reset_unix);

  void AcquireSlot();

  void ReleaseSlot();

  int Remaining() const;

 private:
  void WaitAndDecrement();

  mutable userver::engine::Mutex mu_;
  userver::engine::ConditionVariable cv_;
  int remaining_{-1};
  std::int64_t reset_unix_{0};
  int available_slots_{-1};
};

class CircuitBreaker {
 public:
  enum class State : int { Closed = 0, Open = 1, HalfOpen = 2 };

  static const char* ToString(State state);

  explicit CircuitBreaker(int failure_threshold, std::chrono::seconds open_duration)
      : failure_threshold_(failure_threshold), open_duration_(open_duration) {}

  bool AllowRequest();
  void RecordSuccess();
  void RecordFailure();
  State CurrentState() const;

 private:
  void Trip();
  void Reset();
  bool TryClaimProbe();
  const int failure_threshold_;
  const std::chrono::seconds open_duration_;
  mutable std::mutex mu_;
  std::atomic<State> state_{State::Closed};
  std::atomic<bool> probe_in_flight_{false};
  int consecutive_failures_{0};
  std::chrono::steady_clock::time_point trip_time_{};
};

class TokenBucket {
 public:
  TokenBucket(double tokens_per_sec, int burst_size);

  void Acquire();

  int AvailableTokens() const;

 private:
  void Refill();
  void WaitForToken();

  mutable userver::engine::Mutex mu_;
  userver::engine::ConditionVariable cv_;

  const std::chrono::nanoseconds refill_ns_;
  const int capacity_;
  double tokens_;
  std::chrono::steady_clock::time_point last_refill_;
};

struct LaneConfig {
  double tokens_per_sec{8.0};
  int burst{8};
  int max_concurrent{3};
};

class ResiliencePipeline {
 public:
  ResiliencePipeline(LaneConfig fg,
                     LaneConfig bg,
                     int cb_failure_threshold,
                     std::chrono::seconds cb_open_duration);

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
    explicit Guard(userver::engine::SemaphoreLock lock, RateLimiter& rl);

    void MarkSlotSettled() noexcept {
      slot_settled_ = true;
    }

    userver::engine::SemaphoreLock sem_lock_;
    RateLimiter* rate_limiter_{nullptr};
    bool slot_settled_{false};
  };

  Guard Acquire(Lane lane);

  void OnResponse(Guard& guard,
                  int status_code,
                  int remaining,
                  std::int64_t reset_ts,
                  std::chrono::seconds retry_after = std::chrono::seconds{60});

  void OnNetworkError();

  CircuitBreaker::State CbState() const {
    return cb_.CurrentState();
  }

  int FgTokensAvailable() const {
    return fg_.bucket.AvailableTokens();
  }
  int BgTokensAvailable() const {
    return bg_.bucket.AvailableTokens();
  }
  int FgSlotsAvailable() const {
    return static_cast<int>(fg_.semaphore.RemainingApprox());
  }
  int BgSlotsAvailable() const {
    return static_cast<int>(bg_.semaphore.RemainingApprox());
  }

 private:
  struct LaneData {
    TokenBucket bucket;
    userver::engine::Semaphore semaphore;

    LaneData(LaneConfig cfg)
        : bucket(cfg.tokens_per_sec, cfg.burst),
          semaphore(static_cast<std::size_t>(cfg.max_concurrent)) {}
  };

  LaneData fg_;
  LaneData bg_;
  CircuitBreaker cb_;
  CooldownGate cooldown_;
  RateLimiter rate_limiter_;
};

struct GeniusHttpError : std::runtime_error {
  int status_code;
  explicit GeniusHttpError(int code, const std::string& msg)
      : std::runtime_error(msg), status_code(code) {}
};

std::chrono::milliseconds ExponentialBackoff(int attempt,
                                             std::chrono::milliseconds base,
                                             std::chrono::milliseconds cap);

}  // namespace six_feat