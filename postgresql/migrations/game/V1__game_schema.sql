-- Versioned reference copy of kGameMigrationV1 in services/game/game_store.cpp.
-- The code (game_migrations) is the source of truth; keep this file in sync
-- with it — tests/test_game_migrations.py (SF-DB-05 pattern) enforces parity.
--
-- [SF-GAME-11] Baseline game_* schema. Lives in the same Postgres database as
-- six-feat's own schema, gated by a dedicated game_schema_version table so the
-- two migration registries never collide.

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

-- season_id denormalized onto attempts (also on the challenge) so the season
-- leaderboard top-N is a direct (season_id, score DESC) index scan. Set at
-- submit time (SF-GAME-17/18); nullable until then.
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
