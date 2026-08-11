#pragma once

#include <chrono>
#include <memory>
#include <six-feat-core/rate_limit_store.hpp>
#include <string>
#include <utility>

namespace six_feat {

class PerIpRateLimit {
 public:
  PerIpRateLimit(std::string name,
                 int max_per_window,
                 int window_seconds,
                 std::shared_ptr<RateLimitStore> store = nullptr)
      : name_(std::move(name)),
        max_(max_per_window),
        window_(window_seconds),
        store_(store ? std::move(store) : std::make_shared<InProcessRateLimitStore>()) {}

  bool Allow(const std::string& ip) const {
    return store_->Allow(Key(ip), max_, std::chrono::seconds{window_});
  }

  int Limit() const {
    return max_;
  }

  std::chrono::seconds Window() const {
    return std::chrono::seconds{window_};
  }

  int Remaining(const std::string& key) const {
    return store_->Remaining(Key(key), max_, std::chrono::seconds{window_});
  }

  bool AllowWithTier(const std::string& key,
                     int max_per_window,
                     std::chrono::seconds window) const {
    return store_->Allow(Key(key), max_per_window, window);
  }

  int RemainingWithTier(const std::string& key,
                        int max_per_window,
                        std::chrono::seconds window) const {
    return store_->Remaining(Key(key), max_per_window, window);
  }

 private:
  std::string Key(const std::string& key) const {
    return name_ + ":" + key;
  }

  std::string name_;
  int max_;
  int window_;
  std::shared_ptr<RateLimitStore> store_;
};

}  // namespace six_feat