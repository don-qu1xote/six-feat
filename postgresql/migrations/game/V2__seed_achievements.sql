-- Versioned reference copy of kGameMigrationV2 in services/game/game_store.cpp.
-- The code (game_migrations) is the source of truth; keep this file in sync
-- with it — tests/test_game_migrations.py (SF-DB-05 pattern) enforces parity.
--
-- [SF-GAME-16] Achievement catalog seed. game_achievements is a static lookup
-- table (code → title/description), not player data — the per-player grants
-- live in game_user_achievements, seeded at runtime. ON CONFLICT DO NOTHING
-- keeps the whole migration idempotent, so re-running it against a database
-- that already has the catalog is a no-op rather than a duplicate-key error.
--
-- [SF-GAME-36] This file was missing: the V2 entry existed in game_migrations
-- but had no versioned .sql alongside it, so
-- test_game_migrations.py::test_every_migration_has_a_versioned_sql_file has
-- been failing on the tree. Adding the reference copy, not changing behaviour.

INSERT INTO game_achievements (code, title, descr) VALUES
    ('first_win', 'First Blood', 'Complete your first challenge'),
    ('perfect_solve', 'Perfect Chain', 'Match the ideal path exactly — no wasted hops'),
    ('speedrunner', 'Speedrunner', 'Solve a challenge in under 15 seconds'),
    ('veteran', 'Veteran', 'Play 50 games'),
    ('elo_1500', 'Rising Star', 'Reach 1500 Elo')
ON CONFLICT (code) DO NOTHING;
