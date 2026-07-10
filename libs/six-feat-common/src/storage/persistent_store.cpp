// ════════════════════════════════════════════════════════════════════════════
// persistent_store.cpp  —  iteration 7
//
// PostgreSQL backend via userver::components::Postgres /
// userver::storages::postgres::Cluster. Reads go to a Slave host, writes to
// Master; the cluster's connection pool provides the concurrency the old
// SQLite read-pool/write-mutex split used to provide by hand.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/persistent_store.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/logging/log.hpp>
#include <userver/storages/postgres/cluster.hpp>
#include <userver/storages/postgres/cluster_types.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/storages/postgres/io/array_types.hpp>
#include <userver/storages/postgres/result_set.hpp>
#include <userver/storages/postgres/transaction.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// Schema migrations
//
// Schema version lives in a dedicated `schema_version` table (one row per
// applied version). Migrations are plain forward-only DDL blocks, applied in
// order inside a single transaction, starting one past the DB's current
// version and running up to kTargetSchemaVersion. Registering a migration is
// just appending an entry to kMigrations. See also
// postgresql/migrations/V1__initial_schema.sql, kept in sync with kMigrationV1
// as the versioned reference copy of this same DDL.
// ════════════════════════════════════════════════════════════════════════════

namespace {

struct Migration {
    int                      version;
    std::vector<const char*> statements;
};

// v1: baseline schema (artists/songs/credits/fetch_state + indexes).
// One statement per array element: Cluster::Execute() runs each through the
// extended query protocol, which rejects multiple commands in a single
// prepared statement — unlike SQLite's sqlite3_exec(), which happily ran an
// entire multi-statement script at once.
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
    "CREATE INDEX IF NOT EXISTS idx_credits_artist ON credits(artist_id)",
    "CREATE INDEX IF NOT EXISTS idx_credits_song ON credits(song_id)",
};

// v2: index on fetch_state.depth, needed by ListIncompleteArtists's
// "WHERE depth < $1 ORDER BY artist_id" query used to restore
// under-enriched artists on enrichment startup.
const std::vector<const char*> kMigrationV2 = {
    "CREATE INDEX IF NOT EXISTS idx_fetch_state_depth ON fetch_state(depth)",
};

// Ordered by version; add new entries here as the schema evolves.
const std::vector<Migration> kMigrations = {
    {1, kMigrationV1},
    {2, kMigrationV2},
};

constexpr int kTargetSchemaVersion = 2;

// Applies pending migrations sequentially inside one transaction, from the
// DB's current schema_version up to kTargetSchemaVersion. The migration
// transaction takes an EXCLUSIVE lock on schema_version up front, so if two
// instances race to migrate the same database on startup, the second one
// simply blocks until the first commits, then observes the bumped version
// and has nothing left to do. Idempotent: re-running against an
// already-current DB applies zero migrations.
void RunMigrations(const storages::postgres::ClusterPtr& cluster) {
    cluster->Execute(storages::postgres::ClusterHostType::kMaster,
                      "CREATE TABLE IF NOT EXISTS schema_version ("
                      "  version SMALLINT PRIMARY KEY"
                      ")");

    auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                              storages::postgres::TransactionOptions{});
    trx.Execute("LOCK TABLE schema_version IN EXCLUSIVE MODE");

    auto version_result =
        trx.Execute("SELECT COALESCE(MAX(version), 0) FROM schema_version");
    const int current = version_result.Front()[0].As<std::int16_t>();

    if (current > kTargetSchemaVersion) {
        throw std::runtime_error(
            "PersistentStore: DB schema version " + std::to_string(current) +
            " is newer than the version this binary supports (" +
            std::to_string(kTargetSchemaVersion) + ")");
    }

    for (const auto& m : kMigrations) {
        if (m.version <= current) continue;
        for (const char* stmt : m.statements) {
            trx.Execute(stmt);
        }
        trx.Execute("INSERT INTO schema_version(version) VALUES($1)",
                    m.version);
    }
    trx.Commit();
}

// postgres-db-1 runs with sync-start: false (see static_config.yaml) so a
// slow-to-connect Postgres doesn't crash the whole component system at
// boot — but that just moves the risk here: this is the first real query
// against the cluster, and it used to run once, uncaught, at component
// construction time. If the pool hadn't finished its background connect
// yet, Execute() would throw and PersistentStore's constructor would
// propagate it straight into components::Run, killing the process exactly
// as before, just a few components later. Retrying with backoff here is
// what actually closes that gap: transient "pool not ready yet" failures
// get absorbed instead of taking the whole service down, while a genuinely
// unreachable Postgres still surfaces a clear fatal error once the budget
// (~29s across kMigrationMaxAttempts) is exhausted, rather than hanging
// forever.
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
                LOG_ERROR() << "[PersistentStore] schema migration failed after "
                            << attempt << " attempts, giving up: " << ex.what();
                throw;
            }
            const auto delay = std::min(
                kMigrationBackoffCap,
                kMigrationBackoffBase * (1 << (attempt - 1)));
            LOG_WARNING() << "[PersistentStore] schema migration attempt "
                          << attempt << " failed (" << ex.what()
                          << "), retrying in " << delay.count()
                          << "ms — likely Postgres's connection pool is "
                          << "still starting up";
            engine::SleepFor(delay);
        }
    }
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Role encoding
// ════════════════════════════════════════════════════════════════════════════

namespace {

std::int16_t RoleToInt(const std::string& role) {
    if (role == "primary")  return 1;
    if (role == "featured") return 2;
    if (role == "writer")   return 3;
    if (role == "producer") return 4;
    return 0;
}

std::string IntToRole(std::int16_t r) {
    switch (r) {
        case 1: return "primary";
        case 2: return "featured";
        case 3: return "writer";
        case 4: return "producer";
        default: return "unknown";
    }
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Pimpl
// ════════════════════════════════════════════════════════════════════════════

struct PersistentStore::Impl {
    storages::postgres::ClusterPtr cluster;

    explicit Impl(storages::postgres::ClusterPtr c) : cluster(std::move(c)) {
        RunMigrationsWithRetry(cluster);
    }

    // ── Read helpers ─────────────────────────────────────────────────────

    std::optional<ArtistRef> LoadRef(std::int64_t id) const {
        auto res = cluster->Execute(
            storages::postgres::ClusterHostType::kSlave,
            "SELECT name, image_url, url FROM artists WHERE id = $1", id);
        if (res.IsEmpty()) return std::nullopt;

        const auto row = res.Front();
        ArtistRef r;
        r.id   = id;
        r.name = row[0].As<std::string>();
        r.image = row[1].As<std::optional<std::string>>().value_or("");
        r.url   = row[2].As<std::optional<std::string>>().value_or("");
        return r;
    }

    Depth FetchDepth(std::int64_t artist_id) const {
        auto res = cluster->Execute(
            storages::postgres::ClusterHostType::kSlave,
            "SELECT depth FROM fetch_state WHERE artist_id = $1", artist_id);
        if (res.IsEmpty()) return Depth::None;
        return static_cast<Depth>(res.Front()[0].As<std::int16_t>());
    }

    // Single query: all of the artist's songs plus every credit on those
    // songs, joined against credits+artists. One round trip; rows are
    // grouped by song_id (ORDER BY s.id) as they stream out of Postgres.
    // Columns are addressed positionally — s.id/a.id and s.title/a.name
    // would otherwise collide by name in the result set.
    std::vector<SongRecord> SongsForArtist(std::int64_t artist_id) const {
        auto res = cluster->Execute(
            storages::postgres::ClusterHostType::kSlave,
            "SELECT s.id, s.title, c.role, a.id, a.name, a.image_url, a.url "
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
                rec.id    = song_id;
                rec.title = row[1].As<std::string>();
                songs.push_back(std::move(rec));
            }
            TrackCredit tc;
            tc.role         = IntToRole(row[2].As<std::int16_t>());
            tc.artist.id    = row[3].As<std::int64_t>();
            tc.artist.name  = row[4].As<std::string>();
            tc.artist.image = row[5].As<std::optional<std::string>>().value_or("");
            tc.artist.url   = row[6].As<std::optional<std::string>>().value_or("");
            songs.back().credits.push_back(std::move(tc));
        }
        return songs;
    }

    std::vector<CollabEdge>
    LoadNeighboursImpl(std::int64_t artist_id, const RoleMask& mask) const {
        std::vector<std::int16_t> roles;
        if (mask.primary)  roles.push_back(1);
        if (mask.featured) roles.push_back(2);
        if (mask.writer)   roles.push_back(3);
        if (mask.producer) roles.push_back(4);
        if (roles.empty()) return {};

        auto res = cluster->Execute(
            storages::postgres::ClusterHostType::kSlave,
            "SELECT c2.artist_id, COUNT(DISTINCT c1.song_id) AS w "
            "FROM credits c1 "
            "JOIN credits c2 ON c2.song_id = c1.song_id "
            "              AND c2.artist_id != c1.artist_id "
            "              AND c2.role = ANY($2::smallint[]) "
            "WHERE c1.artist_id = $1 "
            "GROUP BY c2.artist_id",
            artist_id, roles);

        std::vector<CollabEdge> out;
        out.reserve(res.Size());
        for (const auto& row : res) {
            CollabEdge e;
            e.neighbour = row["artist_id"].As<std::int64_t>();
            e.weight    = static_cast<int>(row["w"].As<std::int64_t>());
            out.push_back(e);
        }
        return out;
    }

    std::vector<std::int64_t>
    ListIncompleteImpl(Depth want, int limit, int offset) const {
        auto res = cluster->Execute(
            storages::postgres::ClusterHostType::kSlave,
            "SELECT artist_id FROM fetch_state WHERE depth < $1 "
            "ORDER BY artist_id LIMIT $2 OFFSET $3",
            static_cast<std::int16_t>(want), limit, offset);
        std::vector<std::int64_t> ids;
        ids.reserve(res.Size());
        for (const auto& row : res) ids.push_back(row[0].As<std::int64_t>());
        return ids;
    }

    void UpsertImpl(const ArtistSongs& data, Depth new_depth) {
        auto trx = cluster->Begin(storages::postgres::ClusterHostType::kMaster,
                                  storages::postgres::TransactionOptions{});

        trx.Execute(
            "INSERT INTO artists(id, name, image_url, url) VALUES($1, $2, $3, $4) "
            "ON CONFLICT (id) DO UPDATE SET "
            "  name = excluded.name, image_url = excluded.image_url, url = excluded.url",
            data.seed.id, data.seed.name, data.seed.image, data.seed.url);

        for (const auto& song : data.songs) {
            trx.Execute(
                "INSERT INTO songs(id, title) VALUES($1, $2) "
                "ON CONFLICT (id) DO NOTHING",
                song.id, song.title);

            for (const auto& tc : song.credits) {
                trx.Execute(
                    "INSERT INTO artists(id, name, image_url, url) VALUES($1, $2, $3, $4) "
                    "ON CONFLICT (id) DO NOTHING",
                    tc.artist.id, tc.artist.name, tc.artist.image, tc.artist.url);

                trx.Execute(
                    "INSERT INTO credits(song_id, artist_id, role) VALUES($1, $2, $3) "
                    "ON CONFLICT (song_id, artist_id, role) DO NOTHING",
                    song.id, tc.artist.id, RoleToInt(tc.role));
            }
        }

        const auto now_ts = static_cast<std::int64_t>(
            std::chrono::duration_cast<std::chrono::seconds>(
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
            data.seed.id, static_cast<std::int16_t>(new_depth),
            static_cast<int>(data.songs.size()), now_ts);

        trx.Commit();
    }
};

// ════════════════════════════════════════════════════════════════════════════
// PersistentStore — public methods
// ════════════════════════════════════════════════════════════════════════════

PersistentStore::PersistentStore(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : ComponentBase(config, context)
{
    const std::string dbname = config["dbname"].As<std::string>("postgres-db-1");
    auto cluster = context.FindComponent<components::Postgres>(dbname).GetCluster();
    impl_ = std::make_unique<Impl>(std::move(cluster));
    LOG_INFO() << "[PersistentStore] Postgres cluster ready: " << dbname;
}

PersistentStore::~PersistentStore() = default;

yaml_config::Schema PersistentStore::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(R"(
type: object
description: Durable L1 store for artist/song/credit data
additionalProperties: false
properties:
    dbname:
        type: string
        description: Name of the components::Postgres component whose cluster backs this store
        defaultDescription: postgres-db-1
)");
}

std::optional<ArtistSongs>
PersistentStore::LoadArtistSongs(std::int64_t artist_id, Depth want) const {
    if (impl_->FetchDepth(artist_id) < want) return std::nullopt;
    auto seed_opt = impl_->LoadRef(artist_id);
    if (!seed_opt) return std::nullopt;
    ArtistSongs out;
    out.seed  = std::move(*seed_opt);
    out.songs = impl_->SongsForArtist(artist_id);
    return out;
}

std::optional<ArtistRef>
PersistentStore::LoadArtistRef(std::int64_t artist_id) const {
    return impl_->LoadRef(artist_id);
}

std::vector<CollabEdge>
PersistentStore::LoadNeighbours(std::int64_t artist_id,
                                const RoleMask& mask) const {
    return impl_->LoadNeighboursImpl(artist_id, mask);
}

Depth PersistentStore::GetFetchDepth(std::int64_t artist_id) const {
    return impl_->FetchDepth(artist_id);
}

FetchState PersistentStore::GetFetchState(std::int64_t artist_id) const {
    auto res = impl_->cluster->Execute(
        storages::postgres::ClusterHostType::kSlave,
        "SELECT depth, song_count, last_fetch_ts FROM fetch_state WHERE artist_id = $1",
        artist_id);
    if (res.IsEmpty()) return FetchState{};

    const auto row = res.Front();
    FetchState fs;
    fs.depth         = static_cast<Depth>(row["depth"].As<std::int16_t>());
    fs.song_count    = row["song_count"].As<int>();
    fs.last_fetch_ts = row["last_fetch_ts"].As<std::int64_t>();
    return fs;
}

std::vector<std::int64_t>
PersistentStore::ListIncompleteArtists(Depth want, int limit, int offset) const {
    return impl_->ListIncompleteImpl(want, limit, offset);
}

bool PersistentStore::Ping() const {
    try {
        auto res = impl_->cluster->Execute(
            storages::postgres::ClusterHostType::kSlave, "SELECT 1");
        return !res.IsEmpty();
    } catch (const std::exception& e) {
        LOG_ERROR() << "[PersistentStore] Ping failed: " << e.what();
        return false;
    }
}

void PersistentStore::UpsertArtistSongs(const ArtistSongs& data,
                                         Depth new_depth) {
    impl_->UpsertImpl(data, new_depth);
    LOG_DEBUG() << "[PersistentStore] Upserted artist " << data.seed.id
                << " depth=" << static_cast<int>(new_depth)
                << " songs=" << data.songs.size();
}

} // namespace six_feat
