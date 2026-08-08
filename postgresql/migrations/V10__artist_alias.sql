CREATE TABLE IF NOT EXISTS artist_alias (
    provider             TEXT   NOT NULL,
    provider_artist_id   BIGINT NOT NULL,
    canonical_artist_id  BIGINT NOT NULL REFERENCES artists(id),
    PRIMARY KEY (provider, provider_artist_id)
);
CREATE INDEX IF NOT EXISTS artist_alias_canonical_idx
    ON artist_alias(canonical_artist_id);
