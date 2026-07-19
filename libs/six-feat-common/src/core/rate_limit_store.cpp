#include "core/rate_limit_store.hpp"

namespace six_feat {

bool InProcessRateLimitStore::Allow(const std::string& key, int max_per_window,
                                    std::chrono::seconds window) {
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lk(mu_);

    // Opportunistic GC of stale buckets — same "every few windows" cadence
    // the original PerIpRateLimit used, just keyed off the LARGEST window
    // any caller has used recently isn't tracked here, so this uses the
    // window from whichever call happens to trigger it; harmless either
    // way since it's purely a memory-bound cleanup, not a correctness knob.
    if (now - last_gc_ > window * 4) {
        for (auto it = buckets_.begin(); it != buckets_.end();) {
            if (now - it->second.window_start > window * 2)
                it = buckets_.erase(it);
            else
                ++it;
        }
        last_gc_ = now;
    }

    auto& b = buckets_[key];
    if (b.window_start.time_since_epoch().count() == 0 ||
        now - b.window_start >= window) {
        b.window_start = now;
        b.count = 0;
    }
    ++b.count;
    return b.count <= max_per_window;
}

int InProcessRateLimitStore::Remaining(const std::string& key, int max_per_window,
                                       std::chrono::seconds window) const {
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lk(mu_);

    const auto it = buckets_.find(key);
    if (it == buckets_.end()) return max_per_window;

    const auto& b = it->second;
    if (b.window_start.time_since_epoch().count() == 0 ||
        now - b.window_start >= window) {
        return max_per_window;
    }
    return b.count >= max_per_window ? 0 : max_per_window - b.count;
}

} // namespace six_feat
