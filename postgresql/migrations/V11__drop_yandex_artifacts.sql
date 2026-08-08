-- Yandex removed entirely (no longer a graph provider or a music source to
-- canonicalize against) -- artist_alias (V10) only ever linked a
-- provider-space id back to a canonical artists.id across two providers,
-- and preferred_enrichment_provider (V8) only ever chose between them.
-- Both are dead weight now that Genius is the sole provider.
DROP TABLE IF EXISTS artist_alias;
UPDATE user_settings SET preferred_enrichment_provider = 'genius' WHERE preferred_enrichment_provider != 'genius';
ALTER TABLE user_settings ALTER COLUMN preferred_enrichment_provider SET DEFAULT 'genius';
