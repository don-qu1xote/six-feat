// ════════════════════════════════════════════════════════════════════════════
// persistent_store.cpp  —  iteration 7
//
// PostgreSQL backend via userver::components::Postgres /
// userver::storages::postgres::Cluster. Writes always go to Master. Reads
// go to a Slave host WHEN one is actually configured (DB_REPLICA_HOST set
// — see ReadHostType() below), otherwise straight to Master, so a
// single-instance deployment (the default profile) doesn't spam a "no
// pool for slave, falling back to master" WARNING on every single read.
// The cluster's connection pool provides the concurrency the old SQLite
// read-pool/write-mutex split used to provide by hand.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/persistent_store.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

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
#include <userver/yaml_config/merge_schemas.hpp>

#include "schemas/components/persistent_store_schema.hpp"

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

// v3: [SF-SEC-04] rate_buckets — backs PostgresRateLimitStore (see
// core/rate_limit_store_postgres.cpp), the opt-in shared/multi-replica
// backend for PerIpRateLimit. Fixed-window counters, one row per
// (namespaced rate-limit key, window bucket); PostgresRateLimitStore does
// its own atomic INSERT ... ON CONFLICT DO UPDATE against this table, and
// its own probabilistic cleanup DELETE keyed on window_start — the index
// below is what makes that DELETE a range scan instead of a full table
// scan. Not created/touched at all when every service on this cluster uses
// the default "single" (in-process) rate-limit-store backend — this table
// simply stays empty in that case.
const std::vector<const char*> kMigrationV3 = {
    R"SQL(CREATE TABLE IF NOT EXISTS rate_buckets (
        key          TEXT NOT NULL,
        window_start BIGINT NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key, window_start)
    ))SQL",
    "CREATE INDEX IF NOT EXISTS idx_rate_buckets_window_start ON rate_buckets(window_start)",
};

// Ordered by version; add new entries here as the schema evolves.
const std::vector<Migration> kMigrations = {
    {1, kMigrationV1},
    {2, kMigrationV2},
    {3, kMigrationV3},
};

constexpr int kTargetSchemaVersion = 3;

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

// [fix] Reads were unconditionally routed through ClusterHostType::kSlave
// even in the default (no-replica) deployment profile — see
// docker-compose.yml/DEVELOPMENT.md's "Postgres cluster topology": with a
// single-host dbconnection, userver's Cluster has no Slave pool at all, so
// storages::postgres::detail::ClusterImpl::FindPool logs a WARNING
// ("There is no pool for slave, falling back to master") on EVERY single
// read this component ever makes. The fallback itself was always correct
// (reads still hit master and succeed) — but that WARNING firing on every
// request reads, to anyone watching the logs, exactly like something is
// broken, when nothing is: it's expected, harmless, and permanent for as
// long as no replica is configured, not a transient startup blip.
//
// DB_REPLICA_HOST is the single source of truth for "is there actually a
// second host in dbconnection" — docker-entrypoint.sh only assembles a
// multi-host DSN when it's set (see six-feat's env block in
// docker-compose.yml), so reading the same env var here lets this
// component route reads at kMaster directly when it knows there's no
// Slave pool to find, instead of asking Cluster to discover that the hard
// way on every call. If DB_REPLICA_HOST is set (prod-like profile, SF-
// INF-02, or a real staging replica), reads keep going through kSlave
// exactly as before — genuine Master/Slave read isolation is unaffected.
storages::postgres::ClusterHostType ReadHostType() {
    const char* replica_host = std::getenv("DB_REPLICA_HOST");
    const bool  has_replica  = replica_host != nullptr && *replica_host != '\0';
    return has_replica ? storages::postgres::ClusterHostType::kSlave
                        : storages::postgres::ClusterHostType::kMaster;
}

// [fix] userver's implicit default CommandControl caps statement_timeout at
// 250ms (meant for simple point lookups) — too tight for the multi-table
// join queries on the graph-building hot path (SongsForArtist,
// LoadNeighboursImpl), which legitimately take longer than that under real
// load/cold caches. Without an explicit override here Postgres cancels the
// statement (57014) and the request 502s.
//
// [fix2] An earlier version of this fix just widened both timeouts to
// 2000/3000ms outright — that traded frequent-fast-502s for a much worse
// failure mode: every contended query now held a pool connection for up
// to ~2s instead of failing fast, and under the test suite's request
// volume that was enough to exhaust postgres-db-1's connection pool and
// cascade into a mass timeout regression across unrelated tests (see
// commit 69f739e). A single held connection at 2s is worse than several
// failed-fast ones at 250ms when concurrency is the actual bottleneck.
//
// The budget here stays close to the tight default (just enough headroom
// for genuine one-off slowness) and a bounded retry — one immediate
// re-attempt, see ExecuteJoinQueryWithRetry below — absorbs transient
// contention instead. Worst case is now ~2 short attempts back-to-back,
// never one long hold.
constexpr storages::postgres::CommandControl kJoinQueryCommandControl{
    std::chrono::milliseconds{600}, // network_timeout
    std::chrono::milliseconds{400}, // statement_timeout
};

constexpr int kJoinQueryMaxAttempts = 2;

template <typename Fn>
auto ExecuteJoinQueryWithRetry(Fn&& fn) {
    for (int attempt = 1;; ++attempt) {
        try {
            return fn();
        } catch (const storages::postgres::QueryCancelled& ex) {
            if (attempt >= kJoinQueryMaxAttempts) throw;
            LOG_WARNING() << "[PersistentStore] join query cancelled ("
                          << ex.what() << "), retrying once — attempt "
                          << attempt << "/" << kJoinQueryMaxAttempts;
        }
    }
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Pimpl
// ════════════════════════════════════════════════════════════════════════════

struct PersistentStore::Impl {
    storages::postgres::ClusterPtr cluster;
    // [fix] See ReadHostType()'s own comment above — kMaster when no
    // replica is configured (avoids the "no pool for slave" WARNING on
    // every read), kSlave when one is, computed once here rather than
    // re-checking getenv() per call.
    const storages::postgres::ClusterHostType read_host_type = ReadHostType();

    explicit Impl(storages::postgres::ClusterPtr c) : cluster(std::move(c)) {
        RunMigrationsWithRetry(cluster);
    }

    // ── Read helpers ─────────────────────────────────────────────────────

    std::optional<ArtistRef> LoadRef(std::int64_t id) const {
        auto res = cluster->Execute(
            read_host_type,
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
            read_host_type,
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
        return ExecuteJoinQueryWithRetry([&] {
            auto res = cluster->Execute(
                read_host_type,
                kJoinQueryCommandControl,
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
        });
    }

    std::vector<CollabEdge>
    LoadNeighboursImpl(std::int64_t artist_id, const RoleMask& mask) const {
        std::vector<std::int16_t> roles;
        if (mask.primary)  roles.push_back(1);
        if (mask.featured) roles.push_back(2);
        if (mask.writer)   roles.push_back(3);
        if (mask.producer) roles.push_back(4);
        if (roles.empty()) return {};

        return ExecuteJoinQueryWithRetry([&] {
            auto res = cluster->Execute(
                read_host_type,
                kJoinQueryCommandControl,
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
        });
    }

    std::vector<std::int64_t>
    ListIncompleteImpl(Depth want, int limit, int offset) const {
        auto res = cluster->Execute(
            read_host_type,
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

        // De-dup credit artists by id before sending — the same collaborator
        // can appear on many songs, and UNNEST would otherwise ship (and the
        // planner scan) duplicate rows for no benefit under ON CONFLICT DO
        // NOTHING.
        std::vector<std::int64_t>                     artist_ids;
        std::vector<std::string>                       artist_names;
        std::vector<std::string>                       artist_images;
        std::vector<std::string>                       artist_urls;
        std::unordered_map<std::int64_t, std::size_t>  seen_artists;

        std::vector<std::int64_t> song_ids;
        std::vector<std::string>  song_titles;

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

        // artists and songs must land before credits — credits(song_id,
        // artist_id) both carry FK references (V1 schema).
        if (!artist_ids.empty()) {
            trx.Execute(
                "INSERT INTO artists(id, name, image_url, url) "
                "SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[]) "
                "ON CONFLICT (id) DO NOTHING",
                artist_ids, artist_names, artist_images, artist_urls);
        }

        if (!song_ids.empty()) {
            trx.Execute(
                "INSERT INTO songs(id, title) "
                "SELECT * FROM UNNEST($1::bigint[], $2::text[]) "
                "ON CONFLICT (id) DO NOTHING",
                song_ids, song_titles);
        }

        if (!credit_song_ids.empty()) {
            trx.Execute(
                "INSERT INTO credits(song_id, artist_id, role) "
                "SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::smallint[]) "
                "ON CONFLICT (song_id, artist_id, role) DO NOTHING",
                credit_song_ids, credit_artist_ids, credit_roles);
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
    return yaml_config::MergeSchemas<components::ComponentBase>(kPersistentStoreComponentSchema);
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
        impl_->read_host_type,
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
            impl_->read_host_type, "SELECT 1");
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
