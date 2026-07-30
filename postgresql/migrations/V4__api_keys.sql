
CREATE TABLE IF NOT EXISTS api_keys (
    id           BIGSERIAL PRIMARY KEY,
    key_hash     TEXT NOT NULL UNIQUE,
    owner        TEXT NOT NULL,
    genius_token TEXT NOT NULL,
    rate_tier    TEXT NOT NULL DEFAULT 'default',
    created_at   BIGINT NOT NULL,
    revoked_at   BIGINT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner);
