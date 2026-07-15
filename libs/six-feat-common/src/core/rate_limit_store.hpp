#pragma once

// ════════════════════════════════════════════════════════════════════════════
// rate_limit_store.hpp  —  [SF-SEC-04]
//
// RateLimitStore — the swappable BACKEND behind PerIpRateLimit (see
// rate_limiter.hpp). Extracted because PerIpRateLimit's original
// implementation (std::mutex + unordered_map) is strictly in-process: with
// >1 replica of six-feat behind the load balancer, each replica enforces the
// SAME nominal limit independently, so the effective limit for a client that
// gets round-robined across replicas is (configured limit) × (replica count)
// — not what the configured number is supposed to mean.
//
// Two implementations:
//   - InProcessRateLimitStore — the original std::mutex + unordered_map
//     bucket, generalized to take max/window per call instead of fixed at
//     construction. Still the DEFAULT (single-node) backend — a service
//     with exactly one six-feat replica gets identical behaviour/latency
//     to before this ticket, no Postgres round-trip involved at all.
//   - PostgresRateLimitStore (rate_limit_store_postgres.hpp) — atomic
//     fixed-window counting via a shared `rate_buckets` table on the same
//     Postgres cluster PersistentStore already uses, so every replica sees
//     the same counter. Opt-in via rate-limit-store component config
//     (backend: shared) — see rate_limit_store_component.hpp.
// ════════════════════════════════════════════════════════════════════════════

#include <chrono>
#include <mutex>
#include <string>
#include <unordered_map>

namespace six_feat {

class RateLimitStore {
public:
    virtual ~RateLimitStore() = default;

    // Atomically records one request for `key` in its current fixed window
    // and returns whether it's within `max_per_window`. `key` already
    // includes whatever namespacing the caller needs (PerIpRateLimit
    // prefixes it with a short discriminator, e.g. "graph:1.2.3.4", so
    // multiple independently-configured PerIpRateLimit instances can safely
    // share ONE store without colliding on each other's buckets).
    virtual bool Allow(const std::string& key, int max_per_window,
                        int window_seconds) = 0;

    // Best-effort peek at the remaining allowance for `key` in its CURRENT
    // window, without recording a request — used to report an
    // X-RateLimit-Remaining-style header after Allow() already ran. Never
    // more precise than "as of the last Allow()/Remaining() call": under
    // concurrent access (multiple coroutines, or — for the shared backend —
    // multiple replicas) this is inherently a snapshot, same caveat the
    // original in-process-only version already had.
    virtual int Remaining(const std::string& key, int max_per_window,
                          int window_seconds) const = 0;
};

// ── In-process backend (default, single-node) ───────────────────────────────
//
// Byte-for-byte the same fixed-window bucket algorithm PerIpRateLimit used
// to implement directly: one mutex, one unordered_map<key, Bucket>,
// opportunistic GC of stale buckets. The only change is that max/window are
// now Allow()/Remaining() arguments instead of constructor fields, so one
// InProcessRateLimitStore instance CAN serve callers with different
// max/window values (namespaced by key prefix) — not exercised today (every
// PerIpRateLimit still gets its own private instance, see rate_limiter.hpp),
// but simpler than adding a second single-purpose constructor-bound variant.
class InProcessRateLimitStore final : public RateLimitStore {
public:
    bool Allow(const std::string& key, int max_per_window,
              int window_seconds) override;
    int Remaining(const std::string& key, int max_per_window,
                  int window_seconds) const override;

private:
    struct Bucket {
        std::chrono::steady_clock::time_point window_start{};
        int count{0};
    };

    mutable std::mutex                       mu_;
    std::unordered_map<std::string, Bucket>  buckets_;
    std::chrono::steady_clock::time_point    last_gc_{};
};

} // namespace six_feat
