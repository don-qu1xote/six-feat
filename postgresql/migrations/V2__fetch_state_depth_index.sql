-- Versioned reference copy of kMigrationV2 in src/persistent_store.cpp.
-- The code (kMigrations) is the source of truth; keep this file in sync with it.

CREATE INDEX IF NOT EXISTS idx_fetch_state_depth ON fetch_state(depth);