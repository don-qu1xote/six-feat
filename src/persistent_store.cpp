// ════════════════════════════════════════════════════════════════════════════
// persistent_store.cpp  —  iteration 6
//
// SQLite backend — the default single-binary deployment.
// ════════════════════════════════════════════════════════════════════════════

#include "persistent_store.hpp"

#include <cstdint>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <sqlite3.h>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// Schema DDL
// ════════════════════════════════════════════════════════════════════════════

static constexpr const char* kSchema = R"SQL(
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS artists (
    id        INTEGER PRIMARY KEY,
    name      TEXT    NOT NULL,
    image_url TEXT,
    url       TEXT
);

CREATE TABLE IF NOT EXISTS songs (
    id    INTEGER PRIMARY KEY,
    title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credits (
    song_id   INTEGER NOT NULL REFERENCES songs(id),
    artist_id INTEGER NOT NULL REFERENCES artists(id),
    role      INTEGER NOT NULL,
    PRIMARY KEY (song_id, artist_id, role)
);

CREATE TABLE IF NOT EXISTS fetch_state (
    artist_id    INTEGER PRIMARY KEY REFERENCES artists(id),
    depth        INTEGER NOT NULL,
    song_count   INTEGER NOT NULL,
    last_fetch_ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credits_artist ON credits(artist_id);
CREATE INDEX IF NOT EXISTS idx_credits_song   ON credits(song_id);
)SQL";

// ════════════════════════════════════════════════════════════════════════════
// Role encoding
// ════════════════════════════════════════════════════════════════════════════

namespace {

int RoleToInt(const std::string& role) {
    if (role == "primary")  return 1;
    if (role == "featured") return 2;
    if (role == "writer")   return 3;
    if (role == "producer") return 4;
    return 0;
}

std::string IntToRole(int r) {
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
// SQLite RAII helpers
// ════════════════════════════════════════════════════════════════════════════

namespace {

struct Db {
    sqlite3* handle{nullptr};

    explicit Db(const std::string& path) {
        const int rc = sqlite3_open(path.c_str(), &handle);
        if (rc != SQLITE_OK) {
            const std::string err = sqlite3_errmsg(handle);
            sqlite3_close(handle);
            throw std::runtime_error("SQLite open failed: " + err);
        }
    }
    ~Db() { if (handle) sqlite3_close(handle); }
    Db(const Db&) = delete;
    Db& operator=(const Db&) = delete;
};

struct Stmt {
    sqlite3_stmt* ptr{nullptr};

    Stmt(sqlite3* db, const char* sql) {
        const int rc = sqlite3_prepare_v2(db, sql, -1, &ptr, nullptr);
        if (rc != SQLITE_OK)
            throw std::runtime_error(std::string("SQLite prepare: ") +
                                     sqlite3_errmsg(db));
    }
    ~Stmt() { if (ptr) sqlite3_finalize(ptr); }
    void Reset() { sqlite3_reset(ptr); sqlite3_clear_bindings(ptr); }
    Stmt(const Stmt&) = delete;
    Stmt& operator=(const Stmt&) = delete;
};

void Exec(sqlite3* db, const char* sql) {
    char* err = nullptr;
    const int rc = sqlite3_exec(db, sql, nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        std::string msg = err ? err : "unknown";
        sqlite3_free(err);
        throw std::runtime_error("SQLite exec: " + msg);
    }
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Pimpl
// ════════════════════════════════════════════════════════════════════════════

struct PersistentStore::Impl {
    std::string db_path;
    mutable std::mutex mu;
    mutable Db         db;

    engine::TaskProcessor* fs_tp{nullptr};

    explicit Impl(const std::string& path, engine::TaskProcessor* tp)
        : db_path(path), db(path), fs_tp(tp) {
        Exec(db.handle, kSchema);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    template <typename F>
    auto BlockingCall(F&& fn) const -> decltype(fn()) {
        return utils::Async(*fs_tp, "ps-io", std::forward<F>(fn)).Get();
    }

    std::optional<ArtistRef> LoadRef(std::int64_t id) const {
        Stmt st(db.handle,
                "SELECT name, image_url, url FROM artists WHERE id=?");
        sqlite3_bind_int64(st.ptr, 1, id);
        if (sqlite3_step(st.ptr) != SQLITE_ROW) return std::nullopt;
        ArtistRef r;
        r.id    = id;
        r.name  = reinterpret_cast<const char*>(sqlite3_column_text(st.ptr, 0));
        if (sqlite3_column_type(st.ptr, 1) != SQLITE_NULL)
            r.image = reinterpret_cast<const char*>(sqlite3_column_text(st.ptr, 1));
        if (sqlite3_column_type(st.ptr, 2) != SQLITE_NULL)
            r.url = reinterpret_cast<const char*>(sqlite3_column_text(st.ptr, 2));
        return r;
    }

    Depth FetchDepth(std::int64_t artist_id) const {
        Stmt st(db.handle,
                "SELECT depth FROM fetch_state WHERE artist_id=?");
        sqlite3_bind_int64(st.ptr, 1, artist_id);
        if (sqlite3_step(st.ptr) != SQLITE_ROW) return Depth::None;
        return static_cast<Depth>(sqlite3_column_int(st.ptr, 0));
    }

    std::vector<std::int64_t> SongIdsFor(std::int64_t artist_id) const {
        Stmt st(db.handle,
                "SELECT DISTINCT song_id FROM credits WHERE artist_id=?");
        sqlite3_bind_int64(st.ptr, 1, artist_id);
        std::vector<std::int64_t> ids;
        while (sqlite3_step(st.ptr) == SQLITE_ROW)
            ids.push_back(sqlite3_column_int64(st.ptr, 0));
        return ids;
    }

    SongRecord LoadSong(std::int64_t song_id) const {
        SongRecord rec;
        rec.id = song_id;
        {
            Stmt st(db.handle, "SELECT title FROM songs WHERE id=?");
            sqlite3_bind_int64(st.ptr, 1, song_id);
            if (sqlite3_step(st.ptr) == SQLITE_ROW)
                rec.title = reinterpret_cast<const char*>(
                    sqlite3_column_text(st.ptr, 0));
        }
        {
            Stmt st(db.handle,
                    "SELECT c.role, a.id, a.name, a.image_url, a.url "
                    "FROM credits c JOIN artists a ON a.id=c.artist_id "
                    "WHERE c.song_id=?");
            sqlite3_bind_int64(st.ptr, 1, song_id);
            while (sqlite3_step(st.ptr) == SQLITE_ROW) {
                TrackCredit tc;
                tc.role           = IntToRole(sqlite3_column_int(st.ptr, 0));
                tc.artist.id      = sqlite3_column_int64(st.ptr, 1);
                tc.artist.name    = reinterpret_cast<const char*>(
                    sqlite3_column_text(st.ptr, 2));
                if (sqlite3_column_type(st.ptr, 3) != SQLITE_NULL)
                    tc.artist.image = reinterpret_cast<const char*>(
                        sqlite3_column_text(st.ptr, 3));
                if (sqlite3_column_type(st.ptr, 4) != SQLITE_NULL)
                    tc.artist.url = reinterpret_cast<const char*>(
                        sqlite3_column_text(st.ptr, 4));
                rec.credits.push_back(std::move(tc));
            }
        }
        return rec;
    }

    std::vector<CollabEdge>
    LoadNeighboursImpl(std::int64_t artist_id, const RoleMask& mask) const {
        std::string role_list;
        if (mask.primary)  role_list += "1,";
        if (mask.featured) role_list += "2,";
        if (mask.writer)   role_list += "3,";
        if (mask.producer) role_list += "4,";
        if (role_list.empty()) return {};
        role_list.pop_back();

        const std::string sql =
            "SELECT c2.artist_id, COUNT(DISTINCT c1.song_id) AS w "
            "FROM credits c1 "
            "JOIN credits c2 ON c2.song_id = c1.song_id "
            "              AND c2.artist_id != c1.artist_id "
            "              AND c2.role IN (" + role_list + ") "
            "WHERE c1.artist_id = ? "
            "GROUP BY c2.artist_id";

        Stmt st(db.handle, sql.c_str());
        sqlite3_bind_int64(st.ptr, 1, artist_id);
        std::vector<CollabEdge> out;
        while (sqlite3_step(st.ptr) == SQLITE_ROW) {
            CollabEdge e;
            e.neighbour = sqlite3_column_int64(st.ptr, 0);
            e.weight    = sqlite3_column_int(st.ptr, 1);
            out.push_back(e);
        }
        return out;
    }

    void UpsertImpl(const ArtistSongs& data, Depth new_depth) {
        std::lock_guard lk(mu);
        Exec(db.handle, "BEGIN IMMEDIATE");
        try {
            {
                Stmt st(db.handle,
                        "INSERT OR REPLACE INTO artists(id,name,image_url,url)"
                        "VALUES(?,?,?,?)");
                sqlite3_bind_int64(st.ptr, 1, data.seed.id);
                sqlite3_bind_text(st.ptr, 2, data.seed.name.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(st.ptr, 3, data.seed.image.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(st.ptr, 4, data.seed.url.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_step(st.ptr);
            }
            for (const auto& song : data.songs) {
                {
                    Stmt st(db.handle,
                            "INSERT OR IGNORE INTO songs(id,title) VALUES(?,?)");
                    sqlite3_bind_int64(st.ptr, 1, song.id);
                    sqlite3_bind_text(st.ptr, 2, song.title.c_str(), -1, SQLITE_TRANSIENT);
                    sqlite3_step(st.ptr);
                }
                for (const auto& tc : song.credits) {
                    {
                        Stmt st(db.handle,
                                "INSERT OR IGNORE INTO artists(id,name,image_url,url)"
                                "VALUES(?,?,?,?)");
                        sqlite3_bind_int64(st.ptr, 1, tc.artist.id);
                        sqlite3_bind_text(st.ptr, 2, tc.artist.name.c_str(), -1, SQLITE_TRANSIENT);
                        sqlite3_bind_text(st.ptr, 3, tc.artist.image.c_str(), -1, SQLITE_TRANSIENT);
                        sqlite3_bind_text(st.ptr, 4, tc.artist.url.c_str(), -1, SQLITE_TRANSIENT);
                        sqlite3_step(st.ptr);
                    }
                    {
                        Stmt st(db.handle,
                                "INSERT OR IGNORE INTO credits(song_id,artist_id,role)"
                                "VALUES(?,?,?)");
                        sqlite3_bind_int64(st.ptr, 1, song.id);
                        sqlite3_bind_int64(st.ptr, 2, tc.artist.id);
                        sqlite3_bind_int(st.ptr, 3, RoleToInt(tc.role));
                        sqlite3_step(st.ptr);
                    }
                }
            }
            {
                const auto now_ts = static_cast<std::int64_t>(
                    std::chrono::duration_cast<std::chrono::seconds>(
                        std::chrono::system_clock::now().time_since_epoch())
                        .count());
                Stmt st(db.handle,
                        "INSERT INTO fetch_state(artist_id,depth,song_count,last_fetch_ts)"
                        "VALUES(?,?,?,?) "
                        "ON CONFLICT(artist_id) DO UPDATE SET "
                        "  depth        = MAX(depth, excluded.depth),"
                        "  song_count   = excluded.song_count,"
                        "  last_fetch_ts= excluded.last_fetch_ts "
                        "WHERE excluded.depth >= fetch_state.depth");
                sqlite3_bind_int64(st.ptr, 1, data.seed.id);
                sqlite3_bind_int(st.ptr,   2, static_cast<int>(new_depth));
                sqlite3_bind_int(st.ptr,   3, static_cast<int>(data.songs.size()));
                sqlite3_bind_int64(st.ptr, 4, now_ts);
                sqlite3_step(st.ptr);
            }
            Exec(db.handle, "COMMIT");
        } catch (...) {
            Exec(db.handle, "ROLLBACK");
            throw;
        }
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
    const std::string backend = config["backend"].As<std::string>("sqlite");
    if (backend != "sqlite")
        throw std::runtime_error("PersistentStore: only 'sqlite' backend implemented");

    const std::string path = config["path"].As<std::string>("./six_feat.db");
    auto& tp = context.GetTaskProcessor("fs-blocking");
    impl_ = std::make_unique<Impl>(path, &tp);
    LOG_INFO() << "[PersistentStore] SQLite opened: " << path;
}

PersistentStore::~PersistentStore() = default;

yaml_config::Schema PersistentStore::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(R"(
type: object
description: Durable L1 store for artist/song/credit data
additionalProperties: false
properties:
    backend:
        type: string
        description: Storage backend — 'sqlite' or 'postgresql'
        defaultDescription: sqlite
    path:
        type: string
        description: File path for SQLite DB
        defaultDescription: ./six_feat.db
)");
}

std::optional<ArtistSongs>
PersistentStore::LoadArtistSongs(std::int64_t artist_id, Depth want) const {
    return impl_->BlockingCall([&]() -> std::optional<ArtistSongs> {
        std::lock_guard lk(impl_->mu);
        if (impl_->FetchDepth(artist_id) < want) return std::nullopt;
        auto seed_opt = impl_->LoadRef(artist_id);
        if (!seed_opt) return std::nullopt;
        ArtistSongs out;
        out.seed = std::move(*seed_opt);
        for (const auto sid : impl_->SongIdsFor(artist_id))
            out.songs.push_back(impl_->LoadSong(sid));
        return out;
    });
}

std::optional<ArtistRef>
PersistentStore::LoadArtistRef(std::int64_t artist_id) const {
    return impl_->BlockingCall([&]() -> std::optional<ArtistRef> {
        std::lock_guard lk(impl_->mu);
        return impl_->LoadRef(artist_id);
    });
}

std::vector<CollabEdge>
PersistentStore::LoadNeighbours(std::int64_t artist_id,
                                const RoleMask& mask) const {
    return impl_->BlockingCall([&]() -> std::vector<CollabEdge> {
        std::lock_guard lk(impl_->mu);
        return impl_->LoadNeighboursImpl(artist_id, mask);
    });
}

Depth PersistentStore::GetFetchDepth(std::int64_t artist_id) const {
    return impl_->BlockingCall([&]() -> Depth {
        std::lock_guard lk(impl_->mu);
        return impl_->FetchDepth(artist_id);
    });
}

void PersistentStore::UpsertArtistSongs(const ArtistSongs& data,
                                         Depth new_depth) {
    impl_->BlockingCall([&]() {
        impl_->UpsertImpl(data, new_depth);
    });
    LOG_DEBUG() << "[PersistentStore] Upserted artist " << data.seed.id
                << " depth=" << static_cast<int>(new_depth)
                << " songs=" << data.songs.size();
}

} // namespace six_feat
