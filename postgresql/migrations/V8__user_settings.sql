CREATE TABLE IF NOT EXISTS user_settings (
    user_id                       BIGINT NOT NULL PRIMARY KEY,
    preferred_enrichment_provider TEXT NOT NULL DEFAULT 'yandex'
);
