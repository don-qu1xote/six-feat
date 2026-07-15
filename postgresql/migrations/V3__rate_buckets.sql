-- Versioned reference copy of kMigrationV3 in src/persistent_store.cpp.
-- The code (kMigrations) is the source of truth; keep this file in sync with it.
--
-- [SF-SEC-04] Backs PostgresRateLimitStore (core/rate_limit_store_postgres.cpp),
-- the opt-in shared/multi-replica backend for PerIpRateLimit. Only touched
-- when a rate-limit-store component's `backend` config is "shared" — stays
-- empty (but present) for the default "single" (in-process) backend.

CREATE TABLE IF NOT EXISTS rate_buckets (
    key          TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_buckets_window_start ON rate_buckets(window_start);
