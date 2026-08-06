ALTER TABLE user_settings
    ADD COLUMN IF NOT EXISTS enrichment_enabled BOOLEAN NOT NULL DEFAULT true;
