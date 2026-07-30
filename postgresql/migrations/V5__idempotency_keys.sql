CREATE TABLE IF NOT EXISTS idempotency_keys (
    key           TEXT PRIMARY KEY,
    request_hash  TEXT NOT NULL,
    status_code   SMALLINT NOT NULL,
    response_body TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    expires_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);
