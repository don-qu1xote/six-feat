#pragma once

#include "core/rate_limit_store.hpp"

#include <chrono>
#include <memory>
#include <string>
#include <utility>

namespace six_feat {

// ════════════════════════════════════════════════════════════════════════════
// PerIpRateLimit  —  [ТЗ-5 Part 6.2, backend abstraction: SF-SEC-04]
//
// Strict per-IP fixed-window limiter for ANONYMOUS users (no OAuth token).
// Authenticated users bypass this entirely — they ride their own Genius quota.
//
// Window: `window_seconds`. Each IP gets `max_per_window` requests per window.
//
// [SF-SEC-04] Now a thin adapter over RateLimitStore (core/
// rate_limit_store.hpp) instead of owning the bucket map itself — the
// original std::mutex + unordered_map implementation still exists
// unchanged, just moved into InProcessRateLimitStore, which is what this
// class constructs by default (no behaviour change for a single-replica
// deployment: PerIpRateLimit rl("graph", 50, 1); still gets its own
// private, purely in-process bucket map exactly like before). Pass an
// explicit store (e.g. from RateLimitStoreComponent::MakeStore(), see
// rate_limit_store_component.hpp) to opt into a backend shared across
// replicas — e.g. Postgres-backed, so the SAME 50-per-second actually means
// 50-per-second cluster-wide instead of ×N for N replicas.
// ════════════════════════════════════════════════════════════════════════════

class PerIpRateLimit {
public:
    // `name` namespaces every key this instance ever passes to `store` (as
    // "name:key") — required and non-empty even for the default in-process
    // store, so behaviour never depends on which constructor overload a
    // caller happened to use. It's what lets multiple PerIpRateLimit
    // instances (e.g. one per handler: graph/path/search) safely share ONE
    // RateLimitStore — the Postgres-backed one in particular — without one
    // endpoint's counter colliding with another's for the same client.
    PerIpRateLimit(std::string name, int max_per_window, int window_seconds,
                    std::shared_ptr<RateLimitStore> store = nullptr)
        : name_(std::move(name)),
          max_(max_per_window),
          window_(window_seconds),
          store_(store ? std::move(store)
                        : std::make_shared<InProcessRateLimitStore>()) {}

    /// Returns true if this IP may proceed in the current window.
    bool Allow(const std::string& ip) const {
        return store_->Allow(Key(ip), max_, std::chrono::seconds{window_});
    }

    /// Ceiling of requests per window, exposed so callers can report it
    /// alongside Remaining() (e.g. an X-RateLimit-Limit header).
    int Limit() const { return max_; }

    /// Peeks the remaining allowance for `key` in its current window without
    /// mutating any bucket state — safe to call after Allow() to report the
    /// post-request quota. A key that has never been seen (or whose window
    /// has since rolled over) is reported as having the full allowance.
    int Remaining(const std::string& key) const {
        return store_->Remaining(Key(key), max_, std::chrono::seconds{window_});
    }

private:
    std::string Key(const std::string& key) const { return name_ + ":" + key; }

    std::string                      name_;
    int                               max_;
    int                               window_;
    std::shared_ptr<RateLimitStore>  store_;
};

} // namespace six_feat
