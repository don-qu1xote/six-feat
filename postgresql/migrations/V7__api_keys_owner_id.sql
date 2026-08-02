-- Зеркало kMigrationV7 (libs/six-feat-storage/src/persistent_store.cpp):
-- владение ключом по user_id вместо имени (тёзки между провайдерами входа).
ALTER TABLE api_keys DROP COLUMN IF EXISTS owner;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE api_keys ALTER COLUMN owner_id DROP DEFAULT;

DROP INDEX IF EXISTS idx_api_keys_owner;
CREATE INDEX IF NOT EXISTS idx_api_keys_owner_id ON api_keys(owner_id);

COMMENT ON COLUMN api_keys.owner_id IS 'auth::SessionUserId of the issuing session.';
