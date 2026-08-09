-- V11 left preferred_enrichment_provider with exactly one legal value
-- ('genius') -- there was nothing left to choose between once Yandex was
-- removed, but the state stayed in the database and was read on every
-- authenticated /graph and /path request, then carried across the internal
-- enqueue call into background enrichment. SF-ARCH-07 collapsed the
-- one-element provider chain, so nothing reads the column any more.
ALTER TABLE user_settings DROP COLUMN IF EXISTS preferred_enrichment_provider;
