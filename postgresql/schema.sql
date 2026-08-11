-- Полная схема six-feat одним идемпотентным файлом.
--
-- Проект живёт только в git-репозитории: боевой базы нет, версий схемы нет,
-- поэтому и миграций с реестром версий нет. Этот файл — единственный источник
-- правды о схеме, приложение применяет его (пооператорно, из зеркала
-- kSchemaStatements в libs/six-feat-storage/src/persistent_store.cpp) при
-- каждом старте. Каждая операция идемпотентна: повторный старт, как и старт
-- поверх базы, созданной старыми миграциями, ничего не ломает. Такой же файл
-- для БД игры — postgresql/game/schema.sql.
--
-- Зеркало kSchemaStatements в libs/six-feat-storage/src/persistent_store.cpp:
-- совпадение пооператорно проверяет tests/test_migrations.py.

CREATE TABLE IF NOT EXISTS artists (
    id             BIGINT PRIMARY KEY,
    name           TEXT NOT NULL,
    image_url      TEXT,
    url            TEXT,
    dominant_color TEXT
);

-- [SF-API-23 fix-01] popularity лежит в базе, а не только в памяти запроса:
-- список совместных треков отдаёт /api/v1/graph/edge, а он со второго запроса
-- читает уже из базы, и без колонки сортировка «по популярности» шла по нулям.
CREATE TABLE IF NOT EXISTS songs (
    id         BIGINT PRIMARY KEY,
    title      TEXT NOT NULL,
    popularity BIGINT NOT NULL DEFAULT 0
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

-- [SF-API-20] Средний цвет фотографии артиста — считаем один раз на сервере.
-- NULL — законное состояние «ещё не считали», а не ошибка: колонка
-- заполняется по мере того, как изображения проходят через image-proxy.
-- Backfill не нужен — боевой базы у проекта нет.
COMMENT ON COLUMN artists.dominant_color IS 'average colour of the artist photo as #rrggbb, computed once in the image proxy — NULL means not sampled yet';

COMMENT ON COLUMN songs.popularity IS 'Genius pageviews for the track — orders the shared-track list served by /api/v1/graph/edge and the top_tracks tile on a node';