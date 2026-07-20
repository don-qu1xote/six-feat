#include "game_store.hpp"
#include "scoring.hpp"

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
#include <userver/storages/postgres/transaction.hpp>
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

std::int64_t NowUnix() {
    return std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

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
    const std::int64_t now = NowUnix();
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

// ════════════════════════════════════════════════════════════════════════════
// Public profile lookup + history — [SF-GAME-17]
// ════════════════════════════════════════════════════════════════════════════

std::optional<Profile> GameStore::GetProfileIfExists(std::int64_t user_id) const {
    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kSlave,
        "SELECT 1 FROM game_profiles WHERE user_id = $1", user_id);
    if (res.IsEmpty()) return std::nullopt;
    return ReadProfile(impl_->cluster, user_id);
}

std::vector<AttemptSummary> GameStore::ListRecentAttempts(std::int64_t user_id,
                                                          int limit) const {
    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kSlave,
        "SELECT challenge_id, valid, score, hops, ts FROM game_attempts "
        "WHERE user_id = $1 ORDER BY ts DESC LIMIT $2",
        user_id, limit);

    std::vector<AttemptSummary> out;
    out.reserve(res.Size());
    for (const auto& row : res) {
        AttemptSummary a;
        a.challenge_id = row[0].As<std::int64_t>();
        a.valid        = row[1].As<bool>();
        a.score        = row[2].As<int>();
        a.hops         = row[3].As<int>();
        a.ts           = row[4].As<std::int64_t>();
        out.push_back(a);
    }
    return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Challenge + submission API — [SF-GAME-15]
// ════════════════════════════════════════════════════════════════════════════

std::optional<Challenge> GameStore::GetChallenge(std::int64_t challenge_id) const {
    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "SELECT id, from_artist_id, to_artist_id, role_mask, kind, "
        "       optimal_len, optimal_path, season_id "
        "FROM game_challenges WHERE id = $1", challenge_id);
    if (res.IsEmpty()) return std::nullopt;

    const auto row = res.Front();
    Challenge c;
    c.id             = row[0].As<std::int64_t>();
    c.from_artist_id = row[1].As<std::int64_t>();
    c.to_artist_id   = row[2].As<std::int64_t>();
    c.role_mask      = row[3].As<int>();
    c.kind           = row[4].As<std::string>();
    c.optimal_len    = row[5].As<std::optional<int>>();
    c.optimal_path   = row[6].As<std::optional<std::vector<std::int64_t>>>()
                            .value_or(std::vector<std::int64_t>{});
    c.season_id      = row[7].As<std::optional<std::int64_t>>();
    return c;
}

void GameStore::RecordInvalidAttempt(std::int64_t user_id, std::int64_t challenge_id,
                                     const std::vector<std::int64_t>& chain) const {
    const int hops = std::max(0, static_cast<int>(chain.size()) - 1);
    impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "INSERT INTO game_attempts (challenge_id, user_id, chain, valid, hops, score, ts) "
        "VALUES ($1, $2, $3, false, $4, 0, $5)",
        challenge_id, user_id, chain, hops, NowUnix());
}

SubmitResult GameStore::RecordValidAttempt(std::int64_t user_id, std::int64_t challenge_id,
                                           const std::vector<std::int64_t>& chain,
                                           int optimal_len,
                                           std::optional<int> elapsed_ms,
                                           std::optional<std::int64_t> season_id) const {
    const int player_len = static_cast<int>(chain.size()) - 1;

    // One transaction for the whole read-score-write sequence, per the
    // ticket's explicit requirement — a crash partway through must never
    // leave the attempt row and the profile's elo/games disagreeing. The
    // attempt row this INSERT writes IS the leaderboard update: there is no
    // separate leaderboard table to keep in sync — GetLeaderboard reads
    // straight off game_attempts (see its own comment) — so writing it here
    // already satisfies "пишет attempt + обновляет лидерборд в одной
    // транзакции" without a second write.
    auto trx = impl_->cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                                     storages::postgres::TransactionOptions{});

    // Counted BEFORE this attempt's own INSERT below, so it only reflects
    // attempts strictly earlier than this one (see scoring.hpp's own
    // comment on prior_attempts).
    const auto prior_res = trx.Execute(
        "SELECT COUNT(*) FROM game_attempts WHERE challenge_id = $1 AND user_id = $2",
        challenge_id, user_id);
    const int prior_attempts =
        static_cast<int>(prior_res.Front()[0].As<std::int64_t>());

    const int score = ComputeScore(optimal_len, player_len, prior_attempts, elapsed_ms);

    // FOR UPDATE: serializes concurrent submits by the same player (e.g. two
    // browser tabs) against a read-then-write elo race. The caller
    // (submit_handler.cpp) ensures this row already exists (EnsureAndGetProfile)
    // before starting the attempt, same convention SetDisplayName relies on.
    const auto elo_res = trx.Execute(
        "SELECT elo FROM game_profiles WHERE user_id = $1 FOR UPDATE", user_id);
    const int elo_before = elo_res.IsEmpty() ? 1200 : elo_res.Front()[0].As<int>();

    const auto elo = UpdateElo(elo_before, optimal_len, score, kMaxScore);

    trx.Execute(
        "INSERT INTO game_attempts (challenge_id, user_id, season_id, chain, valid, hops, score, ts) "
        "VALUES ($1, $2, $3, $4, true, $5, $6, $7)",
        challenge_id, user_id, season_id, chain, player_len, score, NowUnix());

    trx.Execute(
        "UPDATE game_profiles SET elo = $2, games = games + 1 WHERE user_id = $1",
        user_id, elo.new_rating);

    trx.Commit();

    SubmitResult r;
    r.player_len = player_len;
    r.score      = score;
    r.max_score  = kMaxScore;
    r.elo_before = elo_before;
    r.elo_after  = elo.new_rating;
    r.elo_delta  = elo.new_rating - elo_before;
    return r;
}

// ════════════════════════════════════════════════════════════════════════════
// Challenge lifecycle — [SF-GAME-16]
// ════════════════════════════════════════════════════════════════════════════

ChallengeUpsertResult GameStore::UpsertChallenge(
    std::int64_t from_artist_id, std::int64_t to_artist_id, int role_mask,
    const std::string& kind, std::optional<std::int64_t> created_by) const {
    // "kind = game_challenges.kind" is a deliberate no-op update: the ONLY
    // reason for a DO UPDATE clause here (instead of DO NOTHING) is that
    // RETURNING otherwise produces zero rows on a conflict — this makes
    // RETURNING fire whether the row was just inserted or already existed,
    // which is exactly the "create or return existing" behaviour the ticket
    // asks for. "(xmax = 0)" is the standard Postgres idiom for telling
    // those two cases apart from the query result: a fresh INSERT leaves
    // xmax at its default 0, an UPDATE (even a no-op one, via ON CONFLICT)
    // always sets it.
    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "INSERT INTO game_challenges "
        "(from_artist_id, to_artist_id, role_mask, kind, created_by, created_ts) "
        "VALUES ($1, $2, $3, $4, $5, $6) "
        "ON CONFLICT (from_artist_id, to_artist_id, role_mask, kind) "
        "DO UPDATE SET kind = game_challenges.kind "
        "RETURNING id, optimal_len, optimal_path, (xmax = 0) AS inserted",
        from_artist_id, to_artist_id, role_mask, kind, created_by, NowUnix());

    const auto row = res.Front();
    ChallengeUpsertResult r;
    r.id           = row[0].As<std::int64_t>();
    r.created      = row[3].As<bool>();
    r.optimal_len  = row[1].As<std::optional<int>>();
    r.optimal_path = row[2].As<std::optional<std::vector<std::int64_t>>>()
                          .value_or(std::vector<std::int64_t>{});
    return r;
}

bool GameStore::SetChallengeIdeal(std::int64_t challenge_id, int optimal_len,
                                  const std::vector<std::int64_t>& optimal_path) const {
    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "UPDATE game_challenges SET optimal_len = $2, optimal_path = $3 "
        "WHERE id = $1 AND optimal_len IS NULL",
        challenge_id, optimal_len, optimal_path);
    return res.RowsAffected() > 0;
}

std::vector<std::int64_t> GameStore::RandomArtistIdsWithCredits(int limit) const {
    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kMaster,
        "SELECT DISTINCT artist_id FROM credits ORDER BY random() LIMIT $1",
        limit);
    std::vector<std::int64_t> out;
    out.reserve(res.Size());
    for (const auto& row : res) out.push_back(row[0].As<std::int64_t>());
    return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Leaderboard — [SF-GAME-17]
// ════════════════════════════════════════════════════════════════════════════

namespace {

// "score:attempt_id" — opaque only in the sense that callers must treat it
// as such, not cryptographically signed (a public leaderboard's own
// pagination internals aren't sensitive). A malformed/tampered cursor
// degrades to nullopt, which GetLeaderboard treats exactly like "no
// cursor" (starts from the top) — harmless, never an error.
std::optional<std::pair<int, std::int64_t>> ParseLeaderboardCursor(
    const std::optional<std::string>& cursor) {
    if (!cursor) return std::nullopt;
    const auto sep = cursor->find(':');
    if (sep == std::string::npos) return std::nullopt;
    try {
        const int          score = std::stoi(cursor->substr(0, sep));
        const std::int64_t id    = std::stoll(cursor->substr(sep + 1));
        return std::make_pair(score, id);
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

} // namespace

LeaderboardPage GameStore::GetLeaderboard(LeaderboardScope scope, std::int64_t scope_id,
                                          const std::optional<std::string>& cursor,
                                          int limit) const {
    const auto parsed = ParseLeaderboardCursor(cursor);
    const std::optional<int>          cursor_score = parsed ? std::optional<int>(parsed->first) : std::nullopt;
    const std::optional<std::int64_t> cursor_id    = parsed ? std::optional<std::int64_t>(parsed->second) : std::nullopt;

    // `scope_column` is one of two hardcoded literals chosen by the enum
    // above — never derived from request input — so splicing it into the
    // SQL text (rather than as a bind parameter, which can't parametrize a
    // column name anyway) carries no injection risk.
    const char* scope_column =
        scope == LeaderboardScope::kChallenge ? "challenge_id" : "season_id";

    // Best-per-player subquery (DISTINCT ON — one row per user_id, their
    // own highest score in scope), then keyset-paginated by
    // (score DESC, attempt id DESC) over that de-duplicated set. Fetches
    // limit+1 rows to know whether a next page exists without a separate
    // COUNT(*) round-trip.
    const std::string sql =
        std::string("SELECT best.user_id, p.display_name, best.score, best.hops, "
                    "best.ts, best.id "
                    "FROM ( "
                    "  SELECT DISTINCT ON (a.user_id) a.user_id, a.score, a.hops, a.ts, a.id "
                    "  FROM game_attempts a "
                    "  WHERE a.") + scope_column + " = $1 AND a.valid = true "
                    "  ORDER BY a.user_id, a.score DESC, a.ts ASC "
                    ") best "
                    "JOIN game_profiles p ON p.user_id = best.user_id "
                    "WHERE ($2::int IS NULL OR (best.score, best.id) < ($2::int, $3::bigint)) "
                    "ORDER BY best.score DESC, best.id DESC "
                    "LIMIT $4";

    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kSlave, sql,
        scope_id, cursor_score, cursor_id, limit + 1);

    struct Row {
        std::int64_t user_id;
        std::string  display_name;
        int          score;
        int          hops;
        std::int64_t ts;
        std::int64_t attempt_id;
    };
    std::vector<Row> rows;
    rows.reserve(res.Size());
    for (const auto& row : res) {
        rows.push_back(Row{
            row[0].As<std::int64_t>(),
            row[1].As<std::optional<std::string>>().value_or(""),
            row[2].As<int>(),
            row[3].As<int>(),
            row[4].As<std::int64_t>(),
            row[5].As<std::int64_t>(),
        });
    }

    LeaderboardPage page;
    const std::size_t take = std::min<std::size_t>(rows.size(), static_cast<std::size_t>(limit));
    page.entries.reserve(take);
    for (std::size_t i = 0; i < take; ++i) {
        page.entries.push_back(LeaderboardEntry{
            rows[i].user_id, rows[i].display_name, rows[i].score,
            rows[i].hops, rows[i].ts,
        });
    }
    if (rows.size() > take) {
        page.next_cursor = std::to_string(rows[take - 1].score) + ":" +
                          std::to_string(rows[take - 1].attempt_id);
    }
    return page;
}

// static
yaml_config::Schema GameStore::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(
        kGameStoreComponentSchema);
}

} // namespace six_feat::game
