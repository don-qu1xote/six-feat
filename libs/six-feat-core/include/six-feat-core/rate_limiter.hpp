#pragma once

#include <six-feat-core/rate_limit_store.hpp>

#include <chrono>
#include <memory>
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

  int Remaining(const std::string& key) const {
    return store_->Remaining(Key(key), max_, std::chrono::seconds{window_});
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