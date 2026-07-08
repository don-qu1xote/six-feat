#pragma once

#include <chrono>
#include <mutex>
#include <string>
#include <unordered_map>

namespace six_feat {

// ════════════════════════════════════════════════════════════════════════════
// PerIpRateLimit  —  [ТЗ-5 Part 6.2]
//
// Strict per-IP fixed-window limiter for ANONYMOUS users (no OAuth token).
// Authenticated users bypass this entirely — they ride their own Genius quota.
//
// Window: `window_seconds`. Each IP gets `max_per_window` requests per window.
// Stale entries (last seen > 2 windows ago) are garbage-collected lazily on
// access to keep the map bounded without a background sweeper.
//
// Guarded by a single mutex. Allow() never suspends a coroutine — the critical
// section is a couple of map operations, so a plain std::mutex is appropriate.
// ════════════════════════════════════════════════════════════════════════════

class PerIpRateLimit {
public:
    PerIpRateLimit(int max_per_window, int window_seconds)
        : max_(max_per_window),
          window_(std::chrono::seconds{window_seconds}) {}

    /// Returns true if this IP may proceed in the current window.
    bool Allow(const std::string& ip) {
        const auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lk(mu_);

        // Opportunistic GC of stale buckets.
        if (now - last_gc_ > window_ * 4) {
            for (auto it = buckets_.begin(); it != buckets_.end();) {
                if (now - it->second.window_start > window_ * 2)
                    it = buckets_.erase(it);
                else
                    ++it;
            }
            last_gc_ = now;
        }

        auto& b = buckets_[ip];
        if (b.window_start.time_since_epoch().count() == 0 ||
            now - b.window_start >= window_) {
            b.window_start = now;
            b.count = 0;
        }
        ++b.count;
        return b.count <= max_;
    }

    /// Ceiling of requests per window, exposed so callers can report it
    /// alongside Remaining() (e.g. an X-RateLimit-Limit header).
    int Limit() const { return max_; }

    /// Peeks the remaining allowance for `key` in its current window without
    /// mutating any bucket state — safe to call after Allow() to report the
    /// post-request quota. A key that has never been seen (or whose window
    /// has since rolled over) is reported as having the full allowance.
    int Remaining(const std::string& key) const {
        const auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lk(mu_);

        const auto it = buckets_.find(key);
        if (it == buckets_.end()) return max_;

        const auto& b = it->second;
        if (b.window_start.time_since_epoch().count() == 0 ||
            now - b.window_start >= window_) {
            return max_;
        }
        return b.count >= max_ ? 0 : max_ - b.count;
    }

private:
    struct Bucket {
        std::chrono::steady_clock::time_point window_start{};
        int count{0};
    };

    int                                   max_;
    std::chrono::steady_clock::duration   window_;
    mutable std::mutex                    mu_;
    std::unordered_map<std::string, Bucket> buckets_;
    std::chrono::steady_clock::time_point last_gc_{};
};

} // namespace six_feat
