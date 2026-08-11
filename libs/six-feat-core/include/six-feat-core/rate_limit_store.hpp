#pragma once

#include <chrono>
#include <mutex>
#include <string>
#include <unordered_map>

namespace six_feat {

class RateLimitStore {
 public:
  virtual ~RateLimitStore() = default;

  virtual bool Allow(const std::string& key, int max_per_window, std::chrono::seconds window) = 0;

  virtual int Remaining(const std::string& key,
                        int max_per_window,
                        std::chrono::seconds window) const = 0;
};

class InProcessRateLimitStore final : public RateLimitStore {
 public:
  bool Allow(const std::string& key, int max_per_window, std::chrono::seconds window) override;
  int Remaining(const std::string& key,
                int max_per_window,
                std::chrono::seconds window) const override;

 private:
  struct Bucket {
    std::chrono::steady_clock::time_point window_start{};
    int count{0};
  };

  mutable std::mutex mu_;
  std::unordered_map<std::string, Bucket> buckets_;
  std::chrono::steady_clock::time_point last_gc_{};
};

}  // namespace six_feat