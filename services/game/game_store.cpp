#include "game_store.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/logging/log.hpp>
#include <userver/storages/postgres/cluster.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "schemas/components/game_store_schema.hpp"

namespace six_feat::game {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// Schema migrations — [SF-GAME-11]
//
// Same shape as libs/six-feat-common/src/storage/persistent_store.cpp's
// kMigrations: forward-only DDL blocks, one statement per array element (the
// extended query protocol rejects multiple commands per prepared statement),
// applied in order inside a single transaction from the DB's current version
// up to kGameTargetSchemaVersion. Version state lives in a DEDICATED
// `game_schema_version` table so it never collides with six-feat's own
// `schema_version` in the same database. Registering a migration is just
// appending to game_migrations.
//
// Kept in sync with postgresql/migrations/game/V*.sql — the code here is the
// source of truth; tests/test_game_migrations.py (SF-DB-05 pattern) fails the
// build if the two ever drift.
// ════════════════════════════════════════════════════════════════════════════

namespace {

struct Migration {
    int                      version;
    std::vector<const char*> statements;
};

// v1: baseline game schema. Tables are created in FK dependency order
// (seasons before challenges, challenges before attempts, achievements before
// user_achievements). All CREATE ... IF NOT EXISTS, so re-running is a no-op.
const std::vector<const char*> kGameMigrationV1 = {
    R"SQL(CREATE TABLE IF NOT EXISTS game_profiles (
        user_id      BIGINT PRIMARY KEY,
        display_name TEXT,
        avatar_url   TEXT,
        elo          INTEGER NOT NULL DEFAULT 1200,
        games        INTEGER NOT NULL DEFAULT 0,
        created_ts   BIGINT NOT NULL
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS game_seasons (
        id        BIGSERIAL PRIMARY KEY,
        name      TEXT NOT NULL,
        starts_ts BIGINT NOT NULL,
        ends_ts   BIGINT NOT NULL
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS game_challenges (
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
    ))SQL",
    // [SF-GAME-11] season_id is denormalized onto attempts (in addition to
    // living on the challenge) so the season leaderboard top-N is a direct
    // (season_id, score DESC) index scan on this table — the ticket's third
    // requested index. Set at submit time (SF-GAME-17/18); nullable until then.
    R"SQL(CREATE TABLE IF NOT EXISTS game_attempts (
        id           BIGSERIAL PRIMARY KEY,
        challenge_id BIGINT NOT NULL REFERENCES game_challenges(id),
        user_id      BIGINT NOT NULL,
        season_id    BIGINT,
        chain        BIGINT[] NOT NULL,
        valid        BOOLEAN NOT NULL,
        hops         INTEGER NOT NULL,
        score        INTEGER NOT NULL,
        ts           BIGINT NOT NULL
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS game_achievements (
        code  TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        descr TEXT
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS game_user_achievements (
        user_id BIGINT NOT NULL,
        code    TEXT NOT NULL REFERENCES game_achievements(code),
        ts      BIGINT NOT NULL,
        PRIMARY KEY (user_id, code)
    ))SQL",
    // Top-N leaderboard indexes (per-challenge, per-season, per-user history).
    "CREATE INDEX IF NOT EXISTS idx_game_attempts_challenge_score ON game_attempts(challenge_id, score DESC)",
    "CREATE INDEX IF NOT EXISTS idx_game_attempts_season_score ON game_attempts(season_id, score DESC)",
    "CREATE INDEX IF NOT EXISTS idx_game_attempts_user_ts ON game_attempts(user_id, ts)",
};

// Ordered by version; add new entries here as the game schema evolves.
const std::vector<Migration> game_migrations = {
    {1, kGameMigrationV1},
};

constexpr int kGameTargetSchemaVersion = 1;

// Applies pending migrations sequentially inside one transaction, from the
// DB's current game_schema_version up to kGameTargetSchemaVersion. An
// EXCLUSIVE lock on game_schema_version serializes racing instances (the
// second one blocks, then observes the bumped version and no-ops). Idempotent.
void RunGameMigrations(const storages::postgres::ClusterPtr& cluster) {
    cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                     "CREATE TABLE IF NOT EXISTS game_schema_version ("
                     "  version SMALLINT PRIMARY KEY"
                     ")");

    auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                              storages::postgres::TransactionOptions{});
    trx.Execute("LOCK TABLE game_schema_version IN EXCLUSIVE MODE");

    auto version_result =
        trx.Execute("SELECT COALESCE(MAX(version), 0) FROM game_schema_version");
    const int current = version_result.Front()[0].As<std::int16_t>();

    if (current > kGameTargetSchemaVersion) {
        throw std::runtime_error(
            "GameStore: DB game schema version " + std::to_string(current) +
            " is newer than the version this binary supports (" +
            std::to_string(kGameTargetSchemaVersion) + ")");
    }

    for (const auto& m : game_migrations) {
        if (m.version <= current) continue;
        for (const char* stmt : m.statements) {
            trx.Execute(stmt);
        }
        trx.Execute("INSERT INTO game_schema_version(version) VALUES($1)",
                    m.version);
    }
    trx.Commit();
}

// Same background-retry posture as PersistentStore (postgres-db-1 has
// sync-start: false): absorb transient "pool not ready yet" failures during a
// startup race; a genuinely unreachable Postgres just leaves the schema
// unmigrated (logged, not fatal) until it recovers.
constexpr int kMigrationMaxAttempts = 10;
constexpr std::chrono::milliseconds kMigrationBackoffBase{200};
constexpr std::chrono::milliseconds kMigrationBackoffCap{5000};

void RunGameMigrationsWithRetry(const storages::postgres::ClusterPtr& cluster) {
    for (int attempt = 1;; ++attempt) {
        try {
            RunGameMigrations(cluster);
            return;
        } catch (const std::exception& ex) {
            if (attempt >= kMigrationMaxAttempts) {
                LOG_ERROR() << "[GameStore] schema migration failed after "
                            << attempt << " attempts, giving up: " << ex.what();
                throw;
            }
            const auto delay = std::min(
                kMigrationBackoffCap,
                kMigrationBackoffBase * (1 << (attempt - 1)));
            LOG_WARNING() << "[GameStore] schema migration attempt " << attempt
                          << " failed (" << ex.what() << "), retrying in "
                          << delay.count() << "ms — likely Postgres's "
                          << "connection pool is still starting up";
            engine::SleepFor(delay);
        }
    }
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Component
// ════════════════════════════════════════════════════════════════════════════

struct GameStore::Impl {
    storages::postgres::ClusterPtr cluster;

    // One unretried attempt up front (fast path: Postgres already reachable →
    // schema ready before the constructor returns). RunGameMigrations is
    // idempotent, so OnAllComponentsLoaded's background retry is a cheap
    // re-check when this already succeeded.
    explicit Impl(storages::postgres::ClusterPtr c) : cluster(std::move(c)) {
        try {
            RunGameMigrations(cluster);
        } catch (const std::exception& ex) {
            LOG_WARNING() << "[GameStore] initial schema migration attempt "
                          << "failed (" << ex.what() << "), deferring to the "
                          << "background retry";
        }
    }
};

GameStore::GameStore(const components::ComponentConfig&  config,
                     const components::ComponentContext& context)
    : ComponentBase(config, context)
    , main_tp_(context.GetTaskProcessor("main-task-processor"))
{
    const std::string dbname = config["dbname"].As<std::string>("postgres-db-1");
    auto cluster = context.FindComponent<components::Postgres>(dbname).GetCluster();
    impl_ = std::make_unique<Impl>(std::move(cluster));
    LOG_INFO() << "[GameStore] Postgres cluster attached: " << dbname;
}

GameStore::~GameStore() = default;

void GameStore::OnAllComponentsLoaded() {
    migration_task_ = utils::Async(main_tp_, "game-store-migrate", [this] {
        try {
            RunGameMigrationsWithRetry(impl_->cluster);
            LOG_INFO() << "[GameStore] schema migrations complete";
        } catch (const std::exception& ex) {
            LOG_ERROR() << "[GameStore] giving up on schema migrations, "
                        << "continuing to serve with an unmigrated/stale "
                        << "schema until Postgres recovers: " << ex.what();
        }
    });
}

bool GameStore::Ping() const {
    try {
        auto res = impl_->cluster->Execute(
            storages::postgres::ClusterHostType::kMaster, "SELECT 1");
        return !res.IsEmpty();
    } catch (const std::exception& e) {
        LOG_ERROR() << "[GameStore] Ping failed: " << e.what();
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Profile API — [SF-GAME-12]
// ════════════════════════════════════════════════════════════════════════════

namespace {

// 1-based leaderboard rank by elo descending: how many profiles strictly
// out-rank this one, plus one. Ties share the higher rank (COUNT of strictly
// greater elo), which is fine for a display rank.
int RankFor(const storages::postgres::ClusterPtr& cluster, int elo) {
    auto res = cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "SELECT COUNT(*) FROM game_profiles WHERE elo > $1", elo);
    return static_cast<int>(res.Front()[0].As<std::int64_t>()) + 1;
}

Profile ReadProfile(const storages::postgres::ClusterPtr& cluster,
                    std::int64_t user_id) {
    auto res = cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "SELECT user_id, display_name, avatar_url, elo, games "
        "FROM game_profiles WHERE user_id = $1", user_id);
    const auto row = res.Front();  // caller guarantees the row exists
    Profile p;
    p.user_id      = row[0].As<std::int64_t>();
    p.display_name = row[1].As<std::optional<std::string>>().value_or("");
    p.avatar_url   = row[2].As<std::optional<std::string>>().value_or("");
    p.elo          = row[3].As<int>();
    p.games        = row[4].As<int>();
    p.rank         = RankFor(cluster, p.elo);
    return p;
}

} // namespace

Profile GameStore::EnsureAndGetProfile(std::int64_t user_id,
                                       const std::string& display_name_default,
                                       const std::string& avatar_url_default) const {
    const std::int64_t now =
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    // First-sight create; existing rows keep their stored values (DO NOTHING).
    impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "INSERT INTO game_profiles (user_id, display_name, avatar_url, created_ts) "
        "VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING",
        user_id,
        display_name_default.empty() ? std::string{"Genius User"} : display_name_default,
        avatar_url_default.empty() ? std::optional<std::string>{} : std::optional<std::string>{avatar_url_default},
        now);
    return ReadProfile(impl_->cluster, user_id);
}

Profile GameStore::SetDisplayName(std::int64_t user_id,
                                  const std::string& display_name) const {
    impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "UPDATE game_profiles SET display_name = $2 WHERE user_id = $1",
        user_id, display_name);
    return ReadProfile(impl_->cluster, user_id);
}

// static
yaml_config::Schema GameStore::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(
        kGameStoreComponentSchema);
}

} // namespace six_feat::game
