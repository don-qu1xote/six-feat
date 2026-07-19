#pragma once

// ════════════════════════════════════════════════════════════════════════════
// rate_limit_store_postgres.hpp  —  [SF-SEC-04]
//
// PostgresRateLimitStore — shared (multi-replica) RateLimitStore backend.
// Same cluster PersistentStore already uses (see rate_limit_store_component.
// hpp's `dbname` config), a separate `rate_buckets` table (migration V3,
// libs/six-feat-common/src/storage/persistent_store.cpp's kMigrations /
// postgresql/migrations/V3__rate_buckets.sql).
//
// Fixed-window counting, atomic across concurrent callers (same replica OR
// different replicas) via a single INSERT ... ON CONFLICT DO UPDATE ...
// RETURNING per Allow() call — Postgres serializes concurrent upserts to the
// same (key, window_start) row, so two replicas racing to increment the same
// bucket never both observe a stale pre-increment count the way two
// independent in-process counters would.
//
// Fails OPEN: any Postgres exception (pool exhausted, network hiccup,
// migration not yet applied) is caught and logged, Allow() returns true /
// Remaining() returns the full allowance. A rate limiter's job is defense
// against abuse, not a second availability dependency for every anonymous
// request — a DB blip should degrade to "briefly unlimited", never to
// "the whole API 500s".
// ════════════════════════════════════════════════════════════════════════════

#include "core/rate_limit_store.hpp"

#include <userver/storages/postgres/cluster.hpp>

namespace six_feat {

class PostgresRateLimitStore final : public RateLimitStore {
public:
    explicit PostgresRateLimitStore(userver::storages::postgres::ClusterPtr cluster);

    bool Allow(const std::string& key, int max_per_window,
              std::chrono::seconds window) override;
    int Remaining(const std::string& key, int max_per_window,
                  std::chrono::seconds window) const override;

private:
    userver::storages::postgres::ClusterPtr cluster_;
};

} // namespace six_feat
