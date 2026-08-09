-- [SF-DOC-08] Схема целиком, одной миграцией.
--
-- До этого их было двенадцать, и половина существовала только чтобы отменить
-- другую половину: V8 заводила preferred_enrichment_provider, V12 её сносила,
-- V10 создавала artist_alias, V11 её сносила — археология откаченного
-- эксперимента с Яндекс.Музыкой (SF-YM-00). Боевой базы у проекта никогда не
-- было, сохранять эту историю не для кого: единственные читатели этих файлов —
-- люди, которым надо понять текущую схему, а не путь к ней.
--
-- Дальше реестр снова append-only: V2 и следующие добавляются, ранее
-- выпущенные не редактируются. Схлопывание — разовая операция «пока не поздно»,
-- и повторить её будет уже нельзя, как только появится база, которую жалко.
--
-- Зеркало kMigrationV1 в libs/six-feat-storage/src/persistent_store.cpp:
-- совпадение пооператорно проверяет tests/test_migrations.py (SF-DB-05).

CREATE TABLE IF NOT EXISTS artists (
    id        BIGINT PRIMARY KEY,
    name      TEXT NOT NULL,
    image_url TEXT,
    url       TEXT
);

CREATE TABLE IF NOT EXISTS songs (
    id    BIGINT PRIMARY KEY,
    title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credits (
    song_id   BIGINT NOT NULL REFERENCES songs(id),
    artist_id BIGINT NOT NULL REFERENCES artists(id),
    role      SMALLINT NOT NULL,
    PRIMARY KEY (song_id, artist_id, role)
);

CREATE TABLE IF NOT EXISTS fetch_state (
    artist_id     BIGINT PRIMARY KEY REFERENCES artists(id),
    depth         SMALLINT NOT NULL,
    song_count    INTEGER NOT NULL,
    last_fetch_ts BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credits_artist ON credits(artist_id);

CREATE INDEX IF NOT EXISTS idx_credits_song ON credits(song_id);

CREATE INDEX IF NOT EXISTS idx_fetch_state_depth ON fetch_state(depth);

CREATE TABLE IF NOT EXISTS rate_buckets (
    key          TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_buckets_window_start ON rate_buckets(window_start);

CREATE TABLE IF NOT EXISTS api_keys (
    id           BIGSERIAL PRIMARY KEY,
    key_hash     TEXT NOT NULL UNIQUE,
    owner_id     BIGINT NOT NULL,
    genius_token TEXT NOT NULL,
    rate_tier    TEXT NOT NULL DEFAULT 'default',
    created_at   BIGINT NOT NULL,
    revoked_at   BIGINT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner_id ON api_keys(owner_id);

COMMENT ON COLUMN api_keys.owner_id IS 'auth::SessionUserId of the issuing session — the key is revocable by its owner through the self-service endpoint';

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key           TEXT PRIMARY KEY,
    request_hash  TEXT NOT NULL,
    status_code   SMALLINT NOT NULL,
    response_body TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    expires_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS user_provider_tokens (
    user_id         BIGINT NOT NULL,
    provider        TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    ts              BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id            BIGINT NOT NULL PRIMARY KEY,
    enrichment_enabled BOOLEAN NOT NULL DEFAULT true
);
