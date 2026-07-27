
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