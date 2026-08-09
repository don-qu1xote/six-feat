
#include "schemas/components/persistent_store_schema.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <six-feat-storage/persistent_store.hpp>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/logging/log.hpp>
#include <userver/storages/postgres/cluster.hpp>
#include <userver/storages/postgres/cluster_types.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/storages/postgres/exceptions.hpp>
#include <userver/storages/postgres/io/array_types.hpp>
#include <userver/storages/postgres/options.hpp>
#include <userver/storages/postgres/result_set.hpp>
#include <userver/storages/postgres/transaction.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

struct Migration {
  int version;
  std::vector<const char*> statements;
};

// [SF-DOC-08] Одна миграция вместо двенадцати.
// Половина прежних версий существовала только чтобы отменить другую половину:
// V8 заводила preferred_enrichment_provider — V12 её сносила, V10 создавала
// artist_alias — V11 её сносила. Это история откаченного эксперимента с
// Яндекс.Музыкой (SF-YM-00), а не история продукта, и хранить её было не для
// кого: боевой базы у проекта никогда не существовало, мигрировать было нечего.
// Дальше реестр снова append-only: V2 и следующие ДОБАВЛЯЮТСЯ, ранее
// выпущенные не редактируются. Схлопывание — разовая операция, повторить её
// будет уже нельзя, как только появится база, которую жалко потерять.
// Зеркало postgresql/migrations/V1__initial_schema.sql, пооператорно —
// проверяет tests/test_migrations.py (SF-DB-05).
const std::vector<const char*> kMigrationV1 = {
    R"SQL(CREATE TABLE IF NOT EXISTS artists (
        id        BIGINT PRIMARY KEY,
        name      TEXT NOT NULL,
        image_url TEXT,
        url       TEXT
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS songs (
        id    BIGINT PRIMARY KEY,
        title TEXT NOT NULL
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS credits (
        song_id   BIGINT NOT NULL REFERENCES songs(id),
        artist_id BIGINT NOT NULL REFERENCES artists(id),
        role      SMALLINT NOT NULL,
        PRIMARY KEY (song_id, artist_id, role)
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS fetch_state (
        artist_id     BIGINT PRIMARY KEY REFERENCES artists(id),
        depth         SMALLINT NOT NULL,
        song_count    INTEGER NOT NULL,
        last_fetch_ts BIGINT NOT NULL
    ))SQL",
    R"SQL(CREATE INDEX IF NOT EXISTS idx_credits_artist ON credits(artist_id))SQL",
    R"SQL(CREATE INDEX IF NOT EXISTS idx_credits_song ON credits(song_id))SQL",
    R"SQL(CREATE INDEX IF NOT EXISTS idx_fetch_state_depth ON fetch_state(depth))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS rate_buckets (
        key          TEXT NOT NULL,
        window_start BIGINT NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key, window_start)
    ))SQL",
    R"SQL(CREATE INDEX IF NOT EXISTS idx_rate_buckets_window_start ON rate_buckets(window_start))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS api_keys (
        id           BIGSERIAL PRIMARY KEY,
        key_hash     TEXT NOT NULL UNIQUE,
        owner_id     BIGINT NOT NULL,
        genius_token TEXT NOT NULL,
        rate_tier    TEXT NOT NULL DEFAULT 'default',
        created_at   BIGINT NOT NULL,
        revoked_at   BIGINT
    ))SQL",
    R"SQL(CREATE INDEX IF NOT EXISTS idx_api_keys_owner_id ON api_keys(owner_id))SQL",
    R"SQL(COMMENT ON COLUMN api_keys.owner_id IS 'auth::SessionUserId of the issuing session — the key is revocable by its owner through the self-service endpoint')SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS idempotency_keys (
        key           TEXT PRIMARY KEY,
        request_hash  TEXT NOT NULL,
        status_code   SMALLINT NOT NULL,
        response_body TEXT NOT NULL,
        created_at    BIGINT NOT NULL,
        expires_at    BIGINT NOT NULL
    ))SQL",
    R"SQL(CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS user_provider_tokens (
        user_id         BIGINT NOT NULL,
        provider        TEXT NOT NULL,
        encrypted_token TEXT NOT NULL,
        ts              BIGINT NOT NULL,
        PRIMARY KEY (user_id, provider)
    ))SQL",
    R"SQL(CREATE TABLE IF NOT EXISTS user_settings (
        user_id            BIGINT NOT NULL PRIMARY KEY,
        enrichment_enabled BOOLEAN NOT NULL DEFAULT true
    ))SQL",
};

const std::vector<Migration> kMigrations = {
    {1, kMigrationV1},
};

constexpr int kTargetSchemaVersion = 1;

void RunMigrations(const storages::postgres::ClusterPtr& cluster) {
  cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                   "CREATE TABLE IF NOT EXISTS schema_version ("
                   "  version SMALLINT PRIMARY KEY"
                   ")");

  auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                            storages::postgres::TransactionOptions{});
  trx.Execute("LOCK TABLE schema_version IN EXCLUSIVE MODE");

  auto version_result = trx.Execute("SELECT COALESCE(MAX(version), 0) FROM schema_version");
  const int current = version_result.Front()[0].As<std::int16_t>();

  // База, оставшаяся от сборки до схлопывания миграций (SF-DOC-08), несёт
  // version=12 и упрётся сюда. Схема у неё та же самая, но доказать это
  // раннер не может, поэтому не угадывает, а говорит, что делать: локальную
  // базу разработчика не жалко, боевой у проекта нет.
  if (current > kTargetSchemaVersion) {
    throw std::runtime_error(
        "PersistentStore: DB schema version " + std::to_string(current) +
        " is newer than the version this binary supports (" + std::to_string(kTargetSchemaVersion) +
        "). If this is a local database created before the migrations were squashed into a "
        "single V1 (SF-DOC-08), recreate it: `make clean` drops the volume, the next start "
        "builds the schema from scratch. There is no production database to preserve.");
  }

  for (const auto& m : kMigrations) {
    if (m.version <= current) continue;
    for (const char* stmt : m.statements) {
      trx.Execute(stmt);
    }
    trx.Execute("INSERT INTO schema_version(version) VALUES($1)", m.version);
  }
  trx.Commit();
}

constexpr int kMigrationMaxAttempts = 10;
constexpr std::chrono::milliseconds kMigrationBackoffBase{200};
constexpr std::chrono::milliseconds kMigrationBackoffCap{5000};

void RunMigrationsWithRetry(const storages::postgres::ClusterPtr& cluster) {
  for (int attempt = 1;; ++attempt) {
    try {
      RunMigrations(cluster);
      return;
    } catch (const std::exception& ex) {
      if (attempt >= kMigrationMaxAttempts) {
        LOG_ERROR() << "[PersistentStore] schema migration failed after " << attempt
                    << " attempts, giving up: " << ex.what();
        throw;
      }
      const auto delay =
          std::min(kMigrationBackoffCap, kMigrationBackoffBase * (1 << (attempt - 1)));
      LOG_WARNING() << "[PersistentStore] schema migration attempt " << attempt << " failed ("
                    << ex.what() << "), retrying in " << delay.count()
                    << "ms — likely Postgres's connection pool is "
                    << "still starting up";
      engine::SleepFor(delay);
    }
  }
}

}  // namespace

namespace {

std::int16_t RoleToInt(const std::string& role) {
  if (role == "primary") return 1;
  if (role == "featured") return 2;
  if (role == "writer") return 3;
  if (role == "producer") return 4;
  return 0;
}

std::string IntToRole(std::int16_t r) {
  switch (r) {
    case 1:
      return "primary";
    case 2:
      return "featured";
    case 3:
      return "writer";
    case 4:
      return "producer";
    default:
      return "unknown";
  }
}

storages::postgres::ClusterHostType ReadHostType() {
  const char* replica_host = std::getenv("DB_REPLICA_HOST");
  const bool has_replica = replica_host != nullptr && *replica_host != '\0';
  return has_replica ? storages::postgres::ClusterHostType::kSlave
                     : storages::postgres::ClusterHostType::kMaster;
}

constexpr storages::postgres::CommandControl kReadQueryCommandControl{
    std::chrono::milliseconds{600},
    std::chrono::milliseconds{400},
};

constexpr int kReadQueryMaxAttempts = 2;

template <typename Fn>
auto ExecuteReadQueryWithRetry(const Fn& fn) {
  for (int attempt = 1;; ++attempt) {
    try {
      return fn();
    } catch (const storages::postgres::Error& ex) {
      if (attempt >= kReadQueryMaxAttempts) throw;
      LOG_WARNING() << "[PersistentStore] read query failed (" << ex.what()
                    << "), retrying once — attempt " << attempt << "/" << kReadQueryMaxAttempts;
    }
  }
}

constexpr storages::postgres::CommandControl kPruneCommandControl{
    std::chrono::milliseconds{2000},
    std::chrono::milliseconds{1500},
};

}  // namespace

struct PersistentStore::Impl {
  storages::postgres::ClusterPtr cluster;
  storages::postgres::ClusterHostType read_host_type = ReadHostType();

  explicit Impl(storages::postgres::ClusterPtr c) : cluster(std::move(c)) {
    try {
      RunMigrations(cluster);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[PersistentStore] initial schema migration "
                    << "attempt failed (" << ex.what() << "), deferring "
                    << "to the background retry";
    }
  }

  std::optional<ArtistRef> LoadRef(std::int64_t id) const {
    return ExecuteReadQueryWithRetry([&] {
      auto res = cluster->Execute(read_host_type,
                                  kReadQueryCommandControl,
                                  "SELECT name, image_url, url FROM artists WHERE id = $1",
                                  id);
      if (res.IsEmpty()) return std::optional<ArtistRef>{};

      const auto row = res.Front();
      ArtistRef r;
      r.id = id;
      r.name = row[0].As<std::string>();
      r.image = row[1].As<std::optional<std::string>>().value_or("");
      r.url = row[2].As<std::optional<std::string>>().value_or("");
      return std::optional<ArtistRef>{std::move(r)};
    });
  }

  // [SF-YM-08] Поиск среди УЖЕ известных артистов (без похода во внешний
  // гейтвей) — не подменяет Genius Search: возвращает только то, что уже
  // резолвлено (кем-то с Genius-токеном или фоновым обогащением) и лежит в
  // этой таблице. Точное совпадение по имени — первым, иначе по длине имени
  // (короче — обычно точнее при ILIKE-подстроке).
  std::vector<ArtistRef> SearchByName(const std::string& query, int limit) const {
    return ExecuteReadQueryWithRetry([&] {
      auto res =
          cluster->Execute(read_host_type,
                           kReadQueryCommandControl,
                           "SELECT id, name, image_url, url FROM artists WHERE name ILIKE $1 "
                           "ORDER BY (lower(name) = lower($2)) DESC, length(name) ASC LIMIT $3",
                           "%" + query + "%",
                           query,
                           limit);
      std::vector<ArtistRef> out;
      out.reserve(res.Size());
      for (const auto& row : res) {
        ArtistRef r;
        r.id = row[0].As<std::int64_t>();
        r.name = row[1].As<std::string>();
        r.image = row[2].As<std::optional<std::string>>().value_or("");
        r.url = row[3].As<std::optional<std::string>>().value_or("");
        out.push_back(std::move(r));
      }
      return out;
    });
  }

  Depth FetchDepth(std::int64_t artist_id) const {
    return ExecuteReadQueryWithRetry([&] {
      auto res = cluster->Execute(read_host_type,
                                  kReadQueryCommandControl,
                                  "SELECT depth FROM fetch_state WHERE artist_id = $1",
                                  artist_id);
      if (res.IsEmpty()) return Depth::kNone;
      return static_cast<Depth>(res.Front()[0].As<std::int16_t>());
    });
  }

  std::vector<SongRecord> SongsForArtist(std::int64_t artist_id) const {
    return ExecuteReadQueryWithRetry([&] {
      auto res = cluster->Execute(
          read_host_type,
          kReadQueryCommandControl,
          "SELECT s.id, s.title, c.role, "
          "       a.id, a.name, a.image_url, a.url "
          "FROM songs s "
          "JOIN credits c ON c.song_id = s.id "
          "JOIN artists a ON a.id = c.artist_id "
          "WHERE s.id IN (SELECT DISTINCT song_id FROM credits WHERE artist_id = $1) "
          "ORDER BY s.id",
          artist_id);

      std::vector<SongRecord> songs;
      for (const auto& row : res) {
        const auto song_id = row[0].As<std::int64_t>();
        if (songs.empty() || songs.back().id != song_id) {
          SongRecord rec;
          rec.id = song_id;
          rec.title = row[1].As<std::string>();
          songs.push_back(std::move(rec));
        }
        TrackCredit tc;
        tc.role = IntToRole(row[2].As<std::int16_t>());
        tc.artist.id = row[3].As<std::int64_t>();
        tc.artist.name = row[4].As<std::string>();
        tc.artist.image = row[5].As<std::optional<std::string>>().value_or("");
        tc.artist.url = row[6].As<std::optional<std::string>>().value_or("");
        songs.back().credits.push_back(std::move(tc));
      }
      return songs;
    });
  }

  std::vector<CollabEdge> LoadNeighboursImpl(std::int64_t artist_id, const RoleMask& mask) const {
    std::vector<std::int16_t> roles;
    if (mask.primary) roles.push_back(1);
    if (mask.featured) roles.push_back(2);
    if (mask.writer) roles.push_back(3);
    if (mask.producer) roles.push_back(4);
    if (roles.empty()) return {};

    return ExecuteReadQueryWithRetry([&] {
      auto res = cluster->Execute(read_host_type,
                                  kReadQueryCommandControl,
                                  "SELECT c2.artist_id AS neighbour_id, "
                                  "       COUNT(DISTINCT LOWER(TRIM(s1.title))) AS w "
                                  "FROM credits c1 "
                                  "JOIN songs s1 ON s1.id = c1.song_id "
                                  "JOIN credits c2 ON c2.song_id = c1.song_id "
                                  "              AND c2.artist_id != c1.artist_id "
                                  "              AND c2.role = ANY($2::smallint[]) "
                                  "WHERE c1.artist_id = $1 "
                                  "GROUP BY c2.artist_id",
                                  artist_id,
                                  roles);

      std::vector<CollabEdge> out;
      out.reserve(res.Size());
      for (const auto& row : res) {
        CollabEdge e{};
        e.neighbour = row["neighbour_id"].As<std::int64_t>();
        e.weight = static_cast<int>(row["w"].As<std::int64_t>());
        e.source = EdgeSource::kGeniusCredit;
        out.push_back(e);
      }
      return out;
    });
  }

  std::vector<std::int64_t> ListIncompleteImpl(Depth want, int limit, int offset) const {
    return ExecuteReadQueryWithRetry([&] {
      auto res = cluster->Execute(read_host_type,
                                  kReadQueryCommandControl,
                                  "SELECT artist_id FROM fetch_state WHERE depth < $1 "
                                  "ORDER BY artist_id LIMIT $2 OFFSET $3",
                                  static_cast<std::int16_t>(want),
                                  limit,
                                  offset);
      std::vector<std::int64_t> ids;
      ids.reserve(res.Size());
      for (const auto& row : res) ids.push_back(row[0].As<std::int64_t>());
      return ids;
    });
  }

  void UpsertImpl(const ArtistSongs& data, Depth new_depth) {
    auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                              storages::postgres::TransactionOptions{});

    trx.Execute(
        "INSERT INTO artists(id, name, image_url, url) VALUES($1, $2, $3, $4) "
        "ON CONFLICT (id) DO UPDATE SET "
        "  name = excluded.name, image_url = excluded.image_url, url = excluded.url",
        data.seed.id,
        data.seed.name,
        data.seed.image,
        data.seed.url);

    std::vector<std::int64_t> artist_ids;
    std::vector<std::string> artist_names;
    std::vector<std::string> artist_images;
    std::vector<std::string> artist_urls;
    std::unordered_map<std::int64_t, std::size_t> seen_artists;

    std::vector<std::int64_t> song_ids;
    std::vector<std::string> song_titles;

    std::vector<std::int64_t> credit_song_ids;
    std::vector<std::int64_t> credit_artist_ids;
    std::vector<std::int16_t> credit_roles;

    for (const auto& song : data.songs) {
      song_ids.push_back(song.id);
      song_titles.push_back(song.title);

      for (const auto& tc : song.credits) {
        if (seen_artists.emplace(tc.artist.id, artist_ids.size()).second) {
          artist_ids.push_back(tc.artist.id);
          artist_names.push_back(tc.artist.name);
          artist_images.push_back(tc.artist.image);
          artist_urls.push_back(tc.artist.url);
        }
        credit_song_ids.push_back(song.id);
        credit_artist_ids.push_back(tc.artist.id);
        credit_roles.push_back(RoleToInt(tc.role));
      }
    }

    if (!artist_ids.empty()) {
      trx.Execute(
          "INSERT INTO artists(id, name, image_url, url) "
          "SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[]) "
          "ON CONFLICT (id) DO NOTHING",
          artist_ids,
          artist_names,
          artist_images,
          artist_urls);
    }

    if (!song_ids.empty()) {
      trx.Execute(
          "INSERT INTO songs(id, title) "
          "SELECT * FROM UNNEST($1::bigint[], $2::text[]) "
          "ON CONFLICT (id) DO NOTHING",
          song_ids,
          song_titles);
    }

    if (!credit_song_ids.empty()) {
      trx.Execute(
          "INSERT INTO credits(song_id, artist_id, role) "
          "SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::smallint[]) "
          "ON CONFLICT (song_id, artist_id, role) DO NOTHING",
          credit_song_ids,
          credit_artist_ids,
          credit_roles);
    }

    const auto now_ts =
        static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(
                                      std::chrono::system_clock::now().time_since_epoch())
                                      .count());
    trx.Execute(
        "INSERT INTO fetch_state(artist_id, depth, song_count, last_fetch_ts) "
        "VALUES($1, $2, $3, $4) "
        "ON CONFLICT (artist_id) DO UPDATE SET "
        "  depth         = GREATEST(fetch_state.depth, excluded.depth),"
        "  song_count    = excluded.song_count,"
        "  last_fetch_ts = excluded.last_fetch_ts "
        "WHERE excluded.depth >= fetch_state.depth",
        data.seed.id,
        static_cast<std::int16_t>(new_depth),
        static_cast<int>(data.songs.size()),
        now_ts);

    trx.Commit();
  }

  std::int64_t PruneStaleArtistsImpl(std::int64_t cutoff_ts, int batch_size) {
    auto id_res = cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                                   kPruneCommandControl,
                                   "SELECT artist_id FROM fetch_state WHERE last_fetch_ts < $1 "
                                   "ORDER BY artist_id LIMIT $2",
                                   cutoff_ts,
                                   batch_size);
    if (id_res.IsEmpty()) return 0;

    std::vector<std::int64_t> ids;
    ids.reserve(id_res.Size());
    for (const auto& row : id_res) ids.push_back(row[0].As<std::int64_t>());

    auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                              storages::postgres::TransactionOptions{});
    trx.Execute("DELETE FROM credits WHERE artist_id = ANY($1::bigint[])", ids);
    trx.Execute("DELETE FROM fetch_state WHERE artist_id = ANY($1::bigint[])", ids);
    trx.Execute("DELETE FROM artists WHERE id = ANY($1::bigint[])", ids);
    trx.Execute("DELETE FROM songs WHERE id NOT IN (SELECT DISTINCT song_id FROM credits)");
    trx.Commit();

    return static_cast<std::int64_t>(ids.size());
  }
};

PersistentStore::PersistentStore(const components::ComponentConfig& config,
                                 const components::ComponentContext& context)
    : ComponentBase(config, context), main_tp_(context.GetTaskProcessor("main-task-processor")) {
  const std::string dbname = config["dbname"].As<std::string>("postgres-db-1");
  auto cluster = context.FindComponent<components::Postgres>(dbname).GetCluster();
  impl_ = std::make_unique<Impl>(std::move(cluster));
  LOG_INFO() << "[PersistentStore] Postgres cluster attached: " << dbname;
}

PersistentStore::~PersistentStore() = default;

void PersistentStore::OnAllComponentsLoaded() {
  migration_task_ = utils::Async(main_tp_, "persistent-store-migrate", [this] {
    try {
      RunMigrationsWithRetry(impl_->cluster);
      LOG_INFO() << "[PersistentStore] schema migrations complete";
    } catch (const std::exception& ex) {
      LOG_ERROR() << "[PersistentStore] giving up on schema migrations, "
                  << "continuing to serve with an unmigrated/stale "
                  << "schema until Postgres recovers: " << ex.what();
    }
  });
}

yaml_config::Schema PersistentStore::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kPersistentStoreComponentSchema);
}

std::optional<ArtistSongs> PersistentStore::LoadArtistSongs(std::int64_t artist_id,
                                                            Depth want) const {
  if (impl_->FetchDepth(artist_id) < want) return std::nullopt;
  auto seed_opt = impl_->LoadRef(artist_id);
  if (!seed_opt) return std::nullopt;
  ArtistSongs out;
  out.seed = std::move(*seed_opt);
  out.songs = impl_->SongsForArtist(artist_id);
  return out;
}

std::optional<ArtistRef> PersistentStore::LoadArtistRef(std::int64_t artist_id) const {
  return impl_->LoadRef(artist_id);
}

std::vector<ArtistRef> PersistentStore::SearchArtistsByName(const std::string& query,
                                                            int limit) const {
  return impl_->SearchByName(query, limit);
}

std::vector<CollabEdge> PersistentStore::LoadNeighbours(std::int64_t artist_id,
                                                        const RoleMask& mask) const {
  return impl_->LoadNeighboursImpl(artist_id, mask);
}

Depth PersistentStore::GetFetchDepth(std::int64_t artist_id) const {
  return impl_->FetchDepth(artist_id);
}

FetchState PersistentStore::GetFetchState(std::int64_t artist_id) const {
  return ExecuteReadQueryWithRetry([&] {
    auto res = impl_->cluster->Execute(
        impl_->read_host_type,
        kReadQueryCommandControl,
        "SELECT depth, song_count, last_fetch_ts FROM fetch_state WHERE artist_id = $1",
        artist_id);
    if (res.IsEmpty()) return FetchState{};

    const auto row = res.Front();
    FetchState fs;
    fs.depth = static_cast<Depth>(row["depth"].As<std::int16_t>());
    fs.song_count = row["song_count"].As<int>();
    fs.last_fetch_ts = row["last_fetch_ts"].As<std::int64_t>();
    return fs;
  });
}

std::vector<std::int64_t> PersistentStore::ListIncompleteArtists(Depth want,
                                                                 int limit,
                                                                 int offset) const {
  return impl_->ListIncompleteImpl(want, limit, offset);
}

bool PersistentStore::Ping() const {
  try {
    auto res = impl_->cluster->Execute(impl_->read_host_type, "SELECT 1");
    return !res.IsEmpty();
  } catch (const std::exception& e) {
    LOG_ERROR() << "[PersistentStore] Ping failed: " << e.what();
    return false;
  }
}

void PersistentStore::UpsertArtistSongs(const ArtistSongs& data, Depth new_depth) {
  impl_->UpsertImpl(data, new_depth);
  LOG_DEBUG() << "[PersistentStore] Upserted artist " << data.seed.id
              << " depth=" << static_cast<int>(new_depth) << " songs=" << data.songs.size();
}

std::int64_t PersistentStore::PruneStaleArtists(std::int64_t cutoff_ts, int batch_size) {
  const auto pruned = impl_->PruneStaleArtistsImpl(cutoff_ts, batch_size);
  if (pruned > 0) {
    LOG_DEBUG() << "[PersistentStore] pruned " << pruned
                << " stale artist(s) (cutoff_ts=" << cutoff_ts << ", batch_size=" << batch_size
                << ")";
  }
  return pruned;
}

}  // namespace six_feat