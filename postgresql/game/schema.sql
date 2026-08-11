-- Полная схема БД игры одним идемпотентным файлом.
--
-- Миграций и версий схемы нет — см. postgresql/schema.sql. Приложение
-- применяет этот файл (из зеркала kGameSchema в
-- services/game/src/core/game_store.cpp) при каждом старте; каждая операция
-- идемпотентна. Сид достижений — часть бутстрапа: INSERT ... ON CONFLICT
-- DO NOTHING безопасен на любом количестве повторных стартов.
--
-- Зеркало kGameSchema в services/game/src/core/game_store.cpp: совпадение
-- пооператорно проверяет tests/test_game_migrations.py.

CREATE TABLE IF NOT EXISTS game_profiles (
    user_id      BIGINT PRIMARY KEY,
    display_name TEXT,
    avatar_url   TEXT,
    elo          INTEGER NOT NULL DEFAULT 1200,
    games        INTEGER NOT NULL DEFAULT 0,
    created_ts   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_seasons (
    id        BIGSERIAL PRIMARY KEY,
    name      TEXT NOT NULL,
    starts_ts BIGINT NOT NULL,
    ends_ts   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_challenges (
    id             BIGSERIAL PRIMARY KEY,
    from_artist_id BIGINT NOT NULL,
    to_artist_id   BIGINT NOT NULL,
    role_mask      INTEGER NOT NULL DEFAULT 0,
    kind           TEXT NOT NULL,
    season_id      BIGINT REFERENCES game_seasons(id),
    created_by     BIGINT,
    optimal_len    INTEGER,
    optimal_path   BIGINT[],
    created_ts     BIGINT NOT NULL,
    UNIQUE (from_artist_id, to_artist_id, role_mask, kind)
);

CREATE TABLE IF NOT EXISTS game_attempts (
    id           BIGSERIAL PRIMARY KEY,
    challenge_id BIGINT NOT NULL REFERENCES game_challenges(id),
    user_id      BIGINT NOT NULL,
    season_id    BIGINT,
    chain        BIGINT[] NOT NULL,
    valid        BOOLEAN NOT NULL,
    hops         INTEGER NOT NULL,
    score        INTEGER NOT NULL,
    ts           BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_achievements (
    code  TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    descr TEXT
);

CREATE TABLE IF NOT EXISTS game_user_achievements (
    user_id BIGINT NOT NULL,
    code    TEXT NOT NULL REFERENCES game_achievements(code),
    ts      BIGINT NOT NULL,
    PRIMARY KEY (user_id, code)
);

CREATE INDEX IF NOT EXISTS idx_game_attempts_challenge_score ON game_attempts(challenge_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_game_attempts_season_score ON game_attempts(season_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_game_attempts_user_ts ON game_attempts(user_id, ts);

INSERT INTO game_achievements (code, title, descr) VALUES
    ('first_win', 'First Blood', 'Complete your first challenge'),
    ('perfect_solve', 'Perfect Chain', 'Match the ideal path exactly — no wasted hops'),
    ('speedrunner', 'Speedrunner', 'Solve a challenge in under 15 seconds'),
    ('veteran', 'Veteran', 'Play 50 games'),
    ('elo_1500', 'Rising Star', 'Reach 1500 Elo')
ON CONFLICT (code) DO NOTHING;