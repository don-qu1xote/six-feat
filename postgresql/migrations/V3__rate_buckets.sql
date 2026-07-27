
CREATE TABLE IF NOT EXISTS rate_buckets (
    key          TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_buckets_window_start ON rate_buckets(window_start);
