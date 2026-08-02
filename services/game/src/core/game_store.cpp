#include "game_store.hpp"

#include "schemas/components/game_store_schema.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/logging/log.hpp>
#include <userver/storages/postgres/cluster.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/storages/postgres/transaction.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

#include "scoring.hpp"

namespace six_feat::game {

using namespace userver;

namespace {

struct Migration {
  int version;
  std::vector<const char*> statements;
};

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
    // season_id денормализован в attempts для прямого индексного сканирования
    // лидерборда сезона по (season_id, score DESC). Устанавливается при
    // отправке; до этого NULL.
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
    // clang-format off
    "CREATE INDEX IF NOT EXISTS idx_game_attempts_challenge_score ON game_attempts(challenge_id, score DESC)",
    "CREATE INDEX IF NOT EXISTS idx_game_attempts_season_score ON game_attempts(season_id, score DESC)",
    // clang-format on
    "CREATE INDEX IF NOT EXISTS idx_game_attempts_user_ts ON game_attempts(user_id, ts)",
};

// Каталог достижений; код обязан существовать до того, как
// EvaluateAndAwardAchievements сможет его выдать. ON CONFLICT DO NOTHING
// делает повторный запуск безопасным.
const std::vector<const char*> kGameMigrationV2 = {
    R"SQL(INSERT INTO game_achievements (code, title, descr) VALUES
        ('first_win', 'First Blood', 'Complete your first challenge'),
        ('perfect_solve', 'Perfect Chain', 'Match the ideal path exactly — no wasted hops'),
        ('speedrunner', 'Speedrunner', 'Solve a challenge in under 15 seconds'),
        ('veteran', 'Veteran', 'Play 50 games'),
        ('elo_1500', 'Rising Star', 'Reach 1500 Elo')
    ON CONFLICT (code) DO NOTHING)SQL",
};

const std::vector<Migration> kGameMigrations = {
    {1, kGameMigrationV1},
    {2, kGameMigrationV2},
};

constexpr int kGameTargetSchemaVersion = 2;

// Применяет миграции последовательно в одной транзакции. EXCLUSIVE блокировка
// сериализует конкурирующие инстансы. Идемпотентно.
void RunGameMigrations(const storages::postgres::ClusterPtr& cluster) {
  cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                   "CREATE TABLE IF NOT EXISTS game_schema_version ("
                   "  version SMALLINT PRIMARY KEY"
                   ")");

  auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                            storages::postgres::TransactionOptions{});
  trx.Execute("LOCK TABLE game_schema_version IN EXCLUSIVE MODE");

  auto version_result = trx.Execute("SELECT COALESCE(MAX(version), 0) FROM game_schema_version");
  const int current = version_result.Front()[0].As<std::int16_t>();

  if (current > kGameTargetSchemaVersion) {
    throw std::runtime_error("GameStore: DB game schema version " + std::to_string(current) +
                             " is newer than the version this binary supports (" +
                             std::to_string(kGameTargetSchemaVersion) + ")");
  }

  for (const auto& m : kGameMigrations) {
    if (m.version <= current) continue;
    for (const char* stmt : m.statements) {
      trx.Execute(stmt);
    }
    trx.Execute("INSERT INTO game_schema_version(version) VALUES($1)", m.version);
  }
  trx.Commit();
}

// Та же стратегия повторных попыток, что и в PersistentStore: поглощает
// временные ошибки «пул ещё не готов» при старте. Недоступный Postgres
// оставляет схему немигрированной (логируется, но не фатально).
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
        LOG_ERROR() << "[GameStore] schema migration failed after " << attempt
                    << " attempts, giving up: " << ex.what();
        throw;
      }
      const auto delay =
          std::min(kMigrationBackoffCap, kMigrationBackoffBase * (1 << (attempt - 1)));
      LOG_WARNING() << "[GameStore] schema migration attempt " << attempt << " failed ("
                    << ex.what() << "), retrying in " << delay.count() << "ms — likely Postgres's "
                    << "connection pool is still starting up";
      engine::SleepFor(delay);
    }
  }
}

}  // namespace

struct GameStore::Impl {
  storages::postgres::ClusterPtr cluster;

  // Одна попытка миграции в конструкторе (быстрый путь: Postgres уже
  // доступен → схема готова до возврата). RunGameMigrations идемпотентна,
  // поэтому фоновая повторная попытка в OnAllComponentsLoaded — дешёвая
  // перепроверка.
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

GameStore::GameStore(const components::ComponentConfig& config,
                     const components::ComponentContext& context)
    : ComponentBase(config, context), main_tp_(context.GetTaskProcessor("main-task-processor")) {
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
    auto res = impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster, "SELECT 1");
    return !res.IsEmpty();
  } catch (const std::exception& e) {
    LOG_ERROR() << "[GameStore] Ping failed: " << e.what();
    return false;
  }
}

namespace {

std::int64_t NowUnix() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// Ранг в лидерборде по elo (1-based): количество профилей со строго
// бо́льшим elo + 1.
int RankFor(const storages::postgres::ClusterPtr& cluster, int elo) {
  auto res = cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                              "SELECT COUNT(*) FROM game_profiles WHERE elo > $1",
                              elo);
  return static_cast<int>(res.Front()[0].As<std::int64_t>()) + 1;
}

Profile ReadProfile(const storages::postgres::ClusterPtr& cluster, std::int64_t user_id) {
  auto res = cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                              "SELECT user_id, display_name, avatar_url, elo, games "
                              "FROM game_profiles WHERE user_id = $1",
                              user_id);
  const auto row = res.Front();
  Profile p;
  p.user_id = row[0].As<std::int64_t>();
  p.display_name = row[1].As<std::optional<std::string>>().value_or("");
  p.avatar_url = row[2].As<std::optional<std::string>>().value_or("");
  p.elo = row[3].As<int>();
  p.games = row[4].As<int>();
  p.rank = RankFor(cluster, p.elo);
  return p;
}

}  // namespace

Profile GameStore::EnsureAndGetProfile(std::int64_t user_id,
                                       const std::string& display_name_default,
                                       const std::string& avatar_url_default) const {
  const std::int64_t now = NowUnix();
  impl_->cluster->Execute(
      storages::postgres::ClusterHostType::kMaster,
      "INSERT INTO game_profiles (user_id, display_name, avatar_url, created_ts) "
      "VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING",
      user_id,
      display_name_default.empty() ? std::string{"Genius User"} : display_name_default,
      avatar_url_default.empty() ? std::optional<std::string>{}
                                 : std::optional<std::string>{avatar_url_default},
      now);
  return ReadProfile(impl_->cluster, user_id);
}

Profile GameStore::SetDisplayName(std::int64_t user_id, const std::string& display_name) const {
  impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                          "UPDATE game_profiles SET display_name = $2 WHERE user_id = $1",
                          user_id,
                          display_name);
  return ReadProfile(impl_->cluster, user_id);
}

std::optional<Profile> GameStore::GetProfileIfExists(std::int64_t user_id) const {
  auto res = impl_->cluster->Execute(storages::postgres::ClusterHostType::kSlave,
                                     "SELECT 1 FROM game_profiles WHERE user_id = $1",
                                     user_id);
  if (res.IsEmpty()) return std::nullopt;
  return ReadProfile(impl_->cluster, user_id);
}

std::vector<AttemptSummary> GameStore::ListRecentAttempts(std::int64_t user_id, int limit) const {
  auto res =
      impl_->cluster->Execute(storages::postgres::ClusterHostType::kSlave,
                              "SELECT challenge_id, valid, score, hops, ts FROM game_attempts "
                              "WHERE user_id = $1 ORDER BY ts DESC LIMIT $2",
                              user_id,
                              limit);

  std::vector<AttemptSummary> out;
  out.reserve(res.Size());
  for (const auto& row : res) {
    AttemptSummary a;
    a.challenge_id = row[0].As<std::int64_t>();
    a.valid = row[1].As<bool>();
    a.score = row[2].As<int>();
    a.hops = row[3].As<int>();
    a.ts = row[4].As<std::int64_t>();
    out.push_back(a);
  }
  return out;
}

std::optional<Challenge> GameStore::GetChallenge(std::int64_t challenge_id) const {
  auto res = impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                                     "SELECT id, from_artist_id, to_artist_id, role_mask, kind, "
                                     "       optimal_len, optimal_path, season_id "
                                     "FROM game_challenges WHERE id = $1",
                                     challenge_id);
  if (res.IsEmpty()) return std::nullopt;

  const auto row = res.Front();
  Challenge c;
  c.id = row[0].As<std::int64_t>();
  c.from_artist_id = row[1].As<std::int64_t>();
  c.to_artist_id = row[2].As<std::int64_t>();
  c.role_mask = row[3].As<int>();
  c.kind = row[4].As<std::string>();
  c.optimal_len = row[5].As<std::optional<int>>();
  c.optimal_path =
      row[6].As<std::optional<std::vector<std::int64_t>>>().value_or(std::vector<std::int64_t>{});
  c.season_id = row[7].As<std::optional<std::int64_t>>();
  return c;
}

void GameStore::RecordInvalidAttempt(std::int64_t user_id,
                                     std::int64_t challenge_id,
                                     const std::vector<std::int64_t>& chain) const {
  const int hops = std::max(0, static_cast<int>(chain.size()) - 1);
  impl_->cluster->Execute(
      storages::postgres::ClusterHostType::kMaster,
      "INSERT INTO game_attempts (challenge_id, user_id, chain, valid, hops, score, ts) "
      "VALUES ($1, $2, $3, false, $4, 0, $5)",
      challenge_id,
      user_id,
      chain,
      hops,
      NowUnix());
}

SubmitResult GameStore::RecordValidAttempt(std::int64_t user_id,
                                           std::int64_t challenge_id,
                                           const std::vector<std::int64_t>& chain,
                                           int optimal_len,
                                           std::optional<int> elapsed_ms,
                                           std::optional<std::int64_t> season_id) const {
  const int player_len = static_cast<int>(chain.size()) - 1;

  // Транзакция: запись attempt и обновление профиля атомарны.
  // Строка attempt = запись в лидерборд (GetLeaderboard читает game_attempts).
  auto trx = impl_->cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                                   storages::postgres::TransactionOptions{});

  // Счётчик ДО вставки — учитывает только предыдущие попытки.
  const auto prior_res =
      trx.Execute("SELECT COUNT(*) FROM game_attempts WHERE challenge_id = $1 AND user_id = $2",
                  challenge_id,
                  user_id);
  const int prior_attempts = static_cast<int>(prior_res.Front()[0].As<std::int64_t>());

  const int score = ComputeScore(optimal_len, player_len, prior_attempts, elapsed_ms);

  // FOR UPDATE: сериализует конкурентные отправки одного игрока (две
  // вкладки браузера), предотвращая гонку read-then-write elo.
  const auto elo_res =
      trx.Execute("SELECT elo FROM game_profiles WHERE user_id = $1 FOR UPDATE", user_id);
  const int elo_before = elo_res.IsEmpty() ? 1200 : elo_res.Front()[0].As<int>();

  // [fix: анти-абуз] Только первая успешная попытка меняет Elo/счётчик игр.
  // Повторные отправки записываются, но не фармят рейтинг.
  const bool ranked = (prior_attempts == 0);
  const int elo_after =
      ranked ? UpdateElo(elo_before, optimal_len, score, kMaxScore).new_rating : elo_before;

  trx.Execute(
      "INSERT INTO game_attempts (challenge_id, user_id, season_id, chain, valid, hops, score, ts) "
      "VALUES ($1, $2, $3, $4, true, $5, $6, $7)",
      challenge_id,
      user_id,
      season_id,
      chain,
      player_len,
      score,
      NowUnix());

  int games_after = 0;
  if (ranked) {
    const auto games_res = trx.Execute(
        "UPDATE game_profiles SET elo = $2, games = games + 1 "
        "WHERE user_id = $1 RETURNING games",
        user_id,
        elo_after);
    games_after = games_res.Front()[0].As<int>();
  } else {
    const auto games_res =
        trx.Execute("SELECT games FROM game_profiles WHERE user_id = $1", user_id);
    games_after = games_res.IsEmpty() ? 0 : games_res.Front()[0].As<int>();
  }

  trx.Commit();

  SubmitResult r;
  r.player_len = player_len;
  r.score = score;
  r.max_score = kMaxScore;
  r.elo_before = elo_before;
  r.elo_after = elo_after;
  r.elo_delta = elo_after - elo_before;
  r.games_after = games_after;
  return r;
}

namespace {
constexpr int kSpeedrunnerMaxElapsedMs = 15000;
constexpr int kVeteranGames = 50;
constexpr int kEloMasterThreshold = 1500;
}  // namespace

std::vector<std::string> GameStore::EvaluateAndAwardAchievements(
    std::int64_t user_id, const SubmitResult& outcome, std::optional<int> elapsed_ms) const {
  std::vector<std::string> candidates;
  if (outcome.games_after == 1) candidates.emplace_back("first_win");
  if (outcome.score >= outcome.max_score) candidates.emplace_back("perfect_solve");
  if (elapsed_ms && *elapsed_ms < kSpeedrunnerMaxElapsedMs) candidates.emplace_back("speedrunner");
  if (outcome.games_after >= kVeteranGames) candidates.emplace_back("veteran");
  if (outcome.elo_after >= kEloMasterThreshold) candidates.emplace_back("elo_1500");

  std::vector<std::string> newly_awarded;
  for (const auto& code : candidates) {
    // ON CONFLICT DO NOTHING + RETURNING: существующая строка возвращает
    // ноль строк → newly_awarded не дублирует уже полученные достижения.
    auto res = impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                                       "INSERT INTO game_user_achievements (user_id, code, ts) "
                                       "VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING code",
                                       user_id,
                                       code,
                                       NowUnix());
    if (!res.IsEmpty()) newly_awarded.push_back(code);
  }
  return newly_awarded;
}

std::vector<Achievement> GameStore::ListAchievementCatalog() const {
  auto res =
      impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                              "SELECT code, title, descr FROM game_achievements ORDER BY code");

  std::vector<Achievement> out;
  out.reserve(res.Size());
  for (const auto& row : res) {
    Achievement a;
    a.code = row[0].As<std::string>();
    a.title = row[1].As<std::string>();
    a.descr = row[2].As<std::optional<std::string>>().value_or(std::string{});
    a.ts = 0;
    out.push_back(a);
  }
  return out;
}

std::vector<Achievement> GameStore::ListAchievements(std::int64_t user_id) const {
  auto res = impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                                     "SELECT ua.code, a.title, a.descr, ua.ts "
                                     "FROM game_user_achievements ua "
                                     "JOIN game_achievements a ON a.code = ua.code "
                                     "WHERE ua.user_id = $1 ORDER BY ua.ts",
                                     user_id);

  std::vector<Achievement> out;
  out.reserve(res.Size());
  for (const auto& row : res) {
    Achievement a;
    a.code = row[0].As<std::string>();
    a.title = row[1].As<std::string>();
    a.descr = row[2].As<std::optional<std::string>>().value_or(std::string{});
    a.ts = row[3].As<std::int64_t>();
    out.push_back(a);
  }
  return out;
}

// Детерминированные 30-дневные окна от фиксированной эпохи (2024-01-01).
// Два вызывающих кода всегда вычисляют одинаковые [starts_ts, ends_ts) без
// координации; EXCLUSIVE блокировка арбитрирует только кто вставит запись.
constexpr std::int64_t kSeasonEpoch = 1704067200;
constexpr std::int64_t kSeasonLenSeconds = 30LL * 24 * 3600;

Season GameStore::EnsureCurrentSeason() const {
  const auto now = NowUnix();

  auto trx = impl_->cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                                   storages::postgres::TransactionOptions{});
  trx.Execute("LOCK TABLE game_seasons IN EXCLUSIVE MODE");

  auto existing = trx.Execute(
      "SELECT id, name, starts_ts, ends_ts FROM game_seasons "
      "WHERE starts_ts <= $1 AND ends_ts > $1 LIMIT 1",
      now);
  if (!existing.IsEmpty()) {
    trx.Commit();
    const auto row = existing.Front();
    Season s;
    s.id = row[0].As<std::int64_t>();
    s.name = row[1].As<std::string>();
    s.starts_ts = row[2].As<std::int64_t>();
    s.ends_ts = row[3].As<std::int64_t>();
    return s;
  }

  const std::int64_t idx = (now - kSeasonEpoch) / kSeasonLenSeconds;
  const std::int64_t starts = kSeasonEpoch + idx * kSeasonLenSeconds;
  const std::int64_t ends = starts + kSeasonLenSeconds;
  const std::string name = "Season " + std::to_string(idx + 1);

  auto inserted = trx.Execute(
      "INSERT INTO game_seasons (name, starts_ts, ends_ts) "
      "VALUES ($1, $2, $3) RETURNING id",
      name,
      starts,
      ends);
  trx.Commit();

  Season s;
  s.id = inserted.Front()[0].As<std::int64_t>();
  s.name = name;
  s.starts_ts = starts;
  s.ends_ts = ends;
  return s;
}

ChallengeUpsertResult GameStore::UpsertChallenge(std::int64_t from_artist_id,
                                                 std::int64_t to_artist_id,
                                                 int role_mask,
                                                 const std::string& kind,
                                                 std::optional<std::int64_t> created_by,
                                                 std::optional<std::int64_t> season_id) const {
  // DO UPDATE с no-op (kind = game_challenges.kind) нужен, чтобы RETURNING
  // срабатывал при конфликте. (xmax = 0) — идиома Postgres для определения
  // что строка была вставлена, а не обновлена.
  auto res = impl_->cluster->Execute(
      storages::postgres::ClusterHostType::kMaster,
      "INSERT INTO game_challenges "
      "(from_artist_id, to_artist_id, role_mask, kind, season_id, created_by, created_ts) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7) "
      "ON CONFLICT (from_artist_id, to_artist_id, role_mask, kind) "
      "DO UPDATE SET kind = game_challenges.kind "
      "RETURNING id, optimal_len, optimal_path, season_id, (xmax = 0) AS inserted",
      from_artist_id,
      to_artist_id,
      role_mask,
      kind,
      season_id,
      created_by,
      NowUnix());

  const auto row = res.Front();
  ChallengeUpsertResult r;
  r.id = row[0].As<std::int64_t>();
  r.created = row[4].As<bool>();
  r.optimal_len = row[1].As<std::optional<int>>();
  r.optimal_path =
      row[2].As<std::optional<std::vector<std::int64_t>>>().value_or(std::vector<std::int64_t>{});
  r.season_id = row[3].As<std::optional<std::int64_t>>();
  return r;
}

bool GameStore::SetChallengeIdeal(std::int64_t challenge_id,
                                  int optimal_len,
                                  const std::vector<std::int64_t>& optimal_path) const {
  auto res =
      impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                              "UPDATE game_challenges SET optimal_len = $2, optimal_path = $3 "
                              "WHERE id = $1 AND optimal_len IS NULL",
                              challenge_id,
                              optimal_len,
                              optimal_path);
  return res.RowsAffected() > 0;
}

std::vector<std::int64_t> GameStore::RandomArtistIdsWithCredits(int limit) const {
  auto res =
      impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                              "SELECT DISTINCT artist_id FROM credits ORDER BY random() LIMIT $1",
                              limit);
  std::vector<std::int64_t> out;
  out.reserve(res.Size());
  for (const auto& row : res) out.push_back(row[0].As<std::int64_t>());
  return out;
}

std::optional<DailyChallengeView> GameStore::GetLatestDailyChallenge() const {
  auto res =
      impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                              "SELECT c.id, c.from_artist_id, c.to_artist_id, c.role_mask, c.kind, "
                              "       c.optimal_len, c.optimal_path, c.season_id, "
                              "       fa.name, fa.image_url, ta.name, ta.image_url "
                              "FROM game_challenges c "
                              "JOIN artists fa ON fa.id = c.from_artist_id "
                              "JOIN artists ta ON ta.id = c.to_artist_id "
                              "WHERE c.kind = 'daily' "
                              "ORDER BY c.created_ts DESC LIMIT 1");
  if (res.IsEmpty()) return std::nullopt;

  const auto row = res.Front();
  DailyChallengeView view;
  view.challenge.id = row[0].As<std::int64_t>();
  view.challenge.from_artist_id = row[1].As<std::int64_t>();
  view.challenge.to_artist_id = row[2].As<std::int64_t>();
  view.challenge.role_mask = row[3].As<int>();
  view.challenge.kind = row[4].As<std::string>();
  view.challenge.optimal_len = row[5].As<std::optional<int>>();
  view.challenge.optimal_path =
      row[6].As<std::optional<std::vector<std::int64_t>>>().value_or(std::vector<std::int64_t>{});
  view.challenge.season_id = row[7].As<std::optional<std::int64_t>>();
  view.from.id = view.challenge.from_artist_id;
  view.from.name = row[8].As<std::string>();
  view.from.image_url = row[9].As<std::optional<std::string>>();
  view.to.id = view.challenge.to_artist_id;
  view.to.name = row[10].As<std::string>();
  view.to.image_url = row[11].As<std::optional<std::string>>();
  return view;
}

std::vector<ChallengeListItem> GameStore::ListChallenges(
    const std::string& kind,
    const std::string& query,
    std::optional<std::pair<std::int64_t, std::int64_t>> cursor,
    int limit) const {
  const std::optional<std::int64_t> cur_ts =
      cursor ? std::optional<std::int64_t>(cursor->first) : std::nullopt;
  const std::optional<std::int64_t> cur_id =
      cursor ? std::optional<std::int64_t>(cursor->second) : std::nullopt;
  std::string escaped;
  escaped.reserve(query.size());
  for (char c : query) {
    if (c == '%' || c == '_' || c == '\\') escaped.push_back('\\');
    escaped.push_back(c);
  }
  const std::string pattern = escaped.empty() ? std::string{} : "%" + escaped + "%";
  auto res =
      impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                              "SELECT c.id, c.from_artist_id, c.to_artist_id, c.role_mask, c.kind, "
                              "       c.optimal_len, c.season_id, c.created_ts, "
                              "       fa.name, fa.image_url, ta.name, ta.image_url "
                              "FROM game_challenges c "
                              "JOIN artists fa ON fa.id = c.from_artist_id "
                              "JOIN artists ta ON ta.id = c.to_artist_id "
                              "WHERE c.optimal_len IS NOT NULL "
                              "  AND ($1 = '' OR c.kind = $1) "
                              "  AND ($5 = '' OR fa.name ILIKE $5 OR ta.name ILIKE $5) "
                              "  AND ($2::bigint IS NULL OR c.created_ts < $2 "
                              "       OR (c.created_ts = $2 AND c.id < $3)) "
                              "ORDER BY c.created_ts DESC, c.id DESC "
                              "LIMIT $4",
                              kind,
                              cur_ts,
                              cur_id,
                              limit,
                              pattern);

  std::vector<ChallengeListItem> out;
  out.reserve(res.Size());
  for (const auto& row : res) {
    ChallengeListItem item;
    item.challenge.id = row[0].As<std::int64_t>();
    item.challenge.from_artist_id = row[1].As<std::int64_t>();
    item.challenge.to_artist_id = row[2].As<std::int64_t>();
    item.challenge.role_mask = row[3].As<int>();
    item.challenge.kind = row[4].As<std::string>();
    item.challenge.optimal_len = row[5].As<std::optional<int>>();
    item.challenge.season_id = row[6].As<std::optional<std::int64_t>>();
    item.created_ts = row[7].As<std::int64_t>();
    item.from.id = item.challenge.from_artist_id;
    item.from.name = row[8].As<std::string>();
    item.from.image_url = row[9].As<std::optional<std::string>>();
    item.to.id = item.challenge.to_artist_id;
    item.to.name = row[10].As<std::string>();
    item.to.image_url = row[11].As<std::optional<std::string>>();
    out.push_back(std::move(item));
  }
  return out;
}

namespace {

std::optional<std::pair<int, std::int64_t>> ParseLeaderboardCursor(
    const std::optional<std::string>& cursor) {
  if (!cursor) return std::nullopt;
  const auto sep = cursor->find(':');
  if (sep == std::string::npos) return std::nullopt;
  try {
    const int score = std::stoi(cursor->substr(0, sep));
    const std::int64_t id = std::stoll(cursor->substr(sep + 1));
    return std::make_pair(score, id);
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

LeaderboardPage SeasonEloBoard(const storages::postgres::ClusterPtr& cluster,
                               const std::optional<std::string>& cursor,
                               int limit) {
  const auto parsed = ParseLeaderboardCursor(cursor);
  const std::optional<int> cur_elo = parsed ? std::optional<int>(parsed->first) : std::nullopt;
  const std::optional<std::int64_t> cur_uid =
      parsed ? std::optional<std::int64_t>(parsed->second) : std::nullopt;

  auto res = cluster->Execute(storages::postgres::ClusterHostType::kSlave,
                              "SELECT user_id, display_name, elo, games "
                              "FROM game_profiles "
                              "WHERE games > 0 "
                              "  AND ($1::int IS NULL OR (elo, user_id) < ($1::int, $2::bigint)) "
                              "ORDER BY elo DESC, user_id DESC "
                              "LIMIT $3",
                              cur_elo,
                              cur_uid,
                              limit + 1);

  struct Row {
    std::int64_t user_id;
    std::string display_name;
    int elo;
    int games;
  };
  std::vector<Row> rows;
  rows.reserve(res.Size());
  for (const auto& row : res) {
    rows.push_back(Row{
        row[0].As<std::int64_t>(),
        row[1].As<std::optional<std::string>>().value_or(""),
        row[2].As<int>(),
        row[3].As<int>(),
    });
  }

  LeaderboardPage page;
  const std::size_t take = std::min<std::size_t>(rows.size(), static_cast<std::size_t>(limit));
  page.entries.reserve(take);
  for (std::size_t i = 0; i < take; ++i) {
    page.entries.push_back(LeaderboardEntry{
        rows[i].user_id,
        rows[i].display_name,
        0,
        0,
        0,
        rows[i].elo,
        rows[i].games,
    });
  }
  if (rows.size() > take) {
    page.next_cursor =
        std::to_string(rows[take - 1].elo) + ":" + std::to_string(rows[take - 1].user_id);
  }
  return page;
}

}  // namespace
LeaderboardPage GameStore::GetLeaderboard(LeaderboardScope scope,
                                          std::int64_t scope_id,
                                          const std::optional<std::string>& cursor,
                                          int limit) const {
  const auto parsed = ParseLeaderboardCursor(cursor);
  const std::optional<int> cursor_score = parsed ? std::optional<int>(parsed->first) : std::nullopt;
  const std::optional<std::int64_t> cursor_id =
      parsed ? std::optional<std::int64_t>(parsed->second) : std::nullopt;

  if (scope == LeaderboardScope::kSeason) {
    return SeasonEloBoard(impl_->cluster, cursor, limit);
  }

  const char* scope_column = "challenge_id";

  const std::string sql =
      std::string(
          "SELECT best.user_id, p.display_name, best.score, best.hops, "
          "best.ts, best.id, p.elo "
          "FROM ( "
          "  SELECT DISTINCT ON (a.user_id) a.user_id, a.score, a.hops, a.ts, a.id "
          "  FROM game_attempts a "
          "  WHERE a.") +
      scope_column +
      " = $1 AND a.valid = true "
      "  ORDER BY a.user_id, a.score DESC, a.ts ASC "
      ") best "
      "JOIN game_profiles p ON p.user_id = best.user_id "
      "WHERE ($2::int IS NULL OR (best.score, best.id) < ($2::int, $3::bigint)) "
      "ORDER BY best.score DESC, best.id DESC "
      "LIMIT $4";

  auto res = impl_->cluster->Execute(storages::postgres::ClusterHostType::kSlave,
                                     sql,
                                     scope_id,
                                     cursor_score,
                                     cursor_id,
                                     limit + 1);

  struct Row {
    std::int64_t user_id;
    std::string display_name;
    int score;
    int hops;
    std::int64_t ts;
    std::int64_t attempt_id;
    int elo;
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
        row[6].As<int>(),
    });
  }

  LeaderboardPage page;
  const std::size_t take = std::min<std::size_t>(rows.size(), static_cast<std::size_t>(limit));
  page.entries.reserve(take);
  for (std::size_t i = 0; i < take; ++i) {
    page.entries.push_back(LeaderboardEntry{
        rows[i].user_id,
        rows[i].display_name,
        rows[i].score,
        rows[i].hops,
        rows[i].ts,
        rows[i].elo,
        0,
    });
  }
  if (rows.size() > take) {
    page.next_cursor =
        std::to_string(rows[take - 1].score) + ":" + std::to_string(rows[take - 1].attempt_id);
  }
  return page;
}

yaml_config::Schema GameStore::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kGameStoreComponentSchema);
}

}  // namespace six_feat::game