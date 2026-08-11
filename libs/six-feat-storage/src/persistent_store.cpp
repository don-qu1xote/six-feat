
#include "schemas/components/persistent_store_schema.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <six-feat-storage/persistent_store.hpp>
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

// Полная схема одним идемпотентным списком: реестра версий и миграций нет.
// Проект живёт только в git-репозитории, боевой базы нет — значит, мигрировать
// нечего, и при каждом старте приложение просто приводит базу к текущей схеме.
// Каждая операция идемпотентна (IF NOT EXISTS / ON CONFLICT), поэтому старт
// поверх базы из прошлой версии приложения, как и повторный старт, ничего не
// ломает; старые таблицы schema_version/game_schema_version, оставшиеся от
// прежнего реестра, просто не трогаются.
// Зеркало postgresql/schema.sql, пооператорно — проверяет

const std::vector<const char*> kSchemaStatements = {
    R"SQL(CREATE TABLE IF NOT EXISTS artists (
        id             BIGINT PRIMARY KEY,
        name           TEXT NOT NULL,
        image_url      TEXT,
        url            TEXT,
        dominant_color TEXT
    ))SQL",
    // [SF-API-23 fix-01] Популярность трека хранится, а не живёт только в
    // памяти запроса. Пока список совместных треков ехал внутри ответа графа,
    // он собирался из свежескачанных песен, и популярность там была. Список
    // уехал в отдельную ручку — а та отвечает уже со второго запроса, то есть
    // из базы, где популярности не было: и сортировка «по популярности», и
    // само поле приезжали нулями. Колонка объявлена прямо в CREATE TABLE:
    // версий схемы нет, отдельный ALTER не нужен.
    R"SQL(CREATE TABLE IF NOT EXISTS songs (
        id         BIGINT PRIMARY KEY,
        title      TEXT NOT NULL,
        popularity BIGINT NOT NULL DEFAULT 0
    ))SQL",
    // CREATE TABLE IF NOT EXISTS не добавит колонку к уже существующей
    // таблице, а весь список обещает быть идемпотентным именно в смысле
    // «поверх базы от прошлой версии приложения». Для новой базы этот ALTER
    // ничего не делает, для старой — доводит её до текущей схемы.
    R"SQL(ALTER TABLE songs ADD COLUMN IF NOT EXISTS popularity BIGINT NOT NULL DEFAULT 0)SQL",
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
    // [SF-API-20] Средний цвет фотографии артиста. Считается один раз в
    // image-proxy — там, где картинка и так скачивается, — и живёт рядом с
    // артистом. NULL значит «ещё не считали»: колонка заполняется по мере
    // прохождения изображений через прокси, backfill не нужен. Колонка
    // объявлена прямо в CREATE TABLE: версий схемы нет, отдельный ALTER
    // не нужен.
    R"SQL(COMMENT ON COLUMN artists.dominant_color IS 'average colour of the artist photo as #rrggbb, computed once in the image proxy — NULL means not sampled yet')SQL",
    R"SQL(COMMENT ON COLUMN songs.popularity IS 'Genius pageviews for the track — orders the shared-track list served by /api/v1/graph/edge and the top_tracks tile on a node')SQL",
};

void BootstrapSchema(const storages::postgres::ClusterPtr& cluster) {
  auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                            storages::postgres::TransactionOptions{});
  for (const char* stmt : kSchemaStatements) {
    trx.Execute(stmt);
  }
  trx.Commit();
}

constexpr int kSchemaMaxAttempts = 10;
constexpr std::chrono::milliseconds kSchemaBackoffBase{200};
constexpr std::chrono::milliseconds kSchemaBackoffCap{5000};

void BootstrapSchemaWithRetry(const storages::postgres::ClusterPtr& cluster) {
  for (int attempt = 1;; ++attempt) {
    try {
      BootstrapSchema(cluster);
      return;
    } catch (const std::exception& ex) {
      if (attempt >= kSchemaMaxAttempts) {
        LOG_ERROR() << "[PersistentStore] schema bootstrap failed after " << attempt
                    << " attempts, giving up: " << ex.what();
        throw;
      }
      const auto delay = std::min(kSchemaBackoffCap, kSchemaBackoffBase * (1 << (attempt - 1)));
      LOG_WARNING() << "[PersistentStore] schema bootstrap attempt " << attempt << " failed ("
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
      BootstrapSchema(cluster);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[PersistentStore] initial schema bootstrap "
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
          "SELECT s.id, s.title, s.popularity, c.role, "
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
          rec.popularity = row[2].As<std::int64_t>();
          songs.push_back(std::move(rec));
        }
        TrackCredit tc;
        tc.role = IntToRole(row[3].As<std::int16_t>());
        tc.artist.id = row[4].As<std::int64_t>();
        tc.artist.name = row[5].As<std::string>();
        tc.artist.image = row[6].As<std::optional<std::string>>().value_or("");
        tc.artist.url = row[7].As<std::optional<std::string>>().value_or("");
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
        "  name = excluded.name, image_url = excluded.image_url, url = excluded.url, "
        // [SF-API-20] Сменилась фотография — посчитанный цвет относится уже
        // не к ней. Обнуляем, а не пересчитываем: пересчёт будет, когда новая
        // картинка пройдёт через прокси.
        "  dominant_color = CASE WHEN artists.image_url IS DISTINCT FROM excluded.image_url "
        "                       THEN NULL ELSE artists.dominant_color END",
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
    std::vector<std::int64_t> song_popularity;

    std::vector<std::int64_t> credit_song_ids;
    std::vector<std::int64_t> credit_artist_ids;
    std::vector<std::int16_t> credit_roles;

    for (const auto& song : data.songs) {
      song_ids.push_back(song.id);
      song_titles.push_back(song.title);
      song_popularity.push_back(song.popularity);

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
      // GREATEST, а не перезапись: фоновое обогащение и передний план ходят в
      // Genius разными запросами, и не в каждом ответе есть stats.pageviews.
      // Ноль от источника, который её не прислал, не должен затирать уже
      // известное число — просмотры только растут.
      trx.Execute(
          "INSERT INTO songs(id, title, popularity) "
          "SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::bigint[]) "
          "ON CONFLICT (id) DO UPDATE SET "
          "  popularity = GREATEST(songs.popularity, excluded.popularity)",
          song_ids,
          song_titles,
          song_popularity);
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
  bootstrap_task_ = utils::Async(main_tp_, "persistent-store-bootstrap", [this] {
    try {
      BootstrapSchemaWithRetry(impl_->cluster);
      LOG_INFO() << "[PersistentStore] schema bootstrap complete";
    } catch (const std::exception& ex) {
      LOG_ERROR() << "[PersistentStore] giving up on schema bootstrap, "
                  << "continuing to serve with the current schema until "
                  << "Postgres recovers: " << ex.what();
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

bool PersistentStore::NeedsDominantColor(const std::string& image_url) const {
  if (image_url.empty()) return false;
  return ExecuteReadQueryWithRetry([&] {
    auto res = impl_->cluster->Execute(
        impl_->read_host_type,
        kReadQueryCommandControl,
        "SELECT 1 FROM artists WHERE image_url = $1 AND dominant_color IS NULL LIMIT 1",
        image_url);
    return !res.IsEmpty();
  });
}

void PersistentStore::SetDominantColor(const std::string& image_url, const std::string& hex) {
  if (image_url.empty() || hex.empty()) return;
  impl_->cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                          "UPDATE artists SET dominant_color = $2 "
                          "WHERE image_url = $1 AND dominant_color IS NULL",
                          image_url,
                          hex);
}

std::unordered_map<std::int64_t, std::string> PersistentStore::LoadDominantColors(
    const std::vector<std::int64_t>& artist_ids) const {
  if (artist_ids.empty()) return {};

  return ExecuteReadQueryWithRetry([&] {
    std::unordered_map<std::int64_t, std::string> colors;
    auto res =
        impl_->cluster->Execute(impl_->read_host_type,
                                kReadQueryCommandControl,
                                "SELECT id, dominant_color FROM artists "
                                "WHERE id = ANY($1::bigint[]) AND dominant_color IS NOT NULL",
                                artist_ids);
    colors.reserve(res.Size());
    for (const auto& row : res) {
      colors.emplace(row["id"].As<std::int64_t>(), row["dominant_color"].As<std::string>());
    }
    return colors;
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