CREATE TABLE IF NOT EXISTS user_provider_tokens (
    user_id         BIGINT NOT NULL,
    provider        TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    ts              BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider)
);
