#include "core/rate_limit_store_postgres.hpp"

#include <chrono>
#include <exception>

#include <userver/logging/log.hpp>
#include <userver/utils/rand.hpp>

namespace six_feat {

namespace {

std::int64_t NowUnix() {
    return static_cast<std::int64_t>(
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
}

// Fixed-window bucket id: every timestamp within the same `window_seconds`
// slice maps to the same window_start, so all replicas incrementing "now"
// land on the same (key, window_start) row regardless of exactly when each
// one's request arrived.
std::int64_t WindowStart(std::int64_t now_unix, int window_seconds) {
    return (now_unix / window_seconds) * window_seconds;
}

// Retention for old windows — 4x whatever window a caller used, so a
// slow-moving caller (large window_seconds) doesn't have its own
// still-relevant-looking history swept just because a DIFFERENT caller's
// cleanup pass ran with a smaller window. Purely a storage-bound cleanup,
// not a correctness knob (Allow()/Remaining() only ever look at the exact
// current window_start).
std::int64_t StaleCutoff(std::int64_t now_unix, int window_seconds) {
    return now_unix - static_cast<std::int64_t>(window_seconds) * 4;
}

} // namespace

PostgresRateLimitStore::PostgresRateLimitStore(
    userver::storages::postgres::ClusterPtr cluster)
    : cluster_(std::move(cluster)) {}

bool PostgresRateLimitStore::Allow(const std::string& key, int max_per_window,
                                   std::chrono::seconds window) {
    const int  window_seconds = static_cast<int>(window.count());
    const auto now_unix       = NowUnix();
    const auto window_start   = WindowStart(now_unix, window_seconds);

    try {
        auto res = cluster_->Execute(
            userver::storages::postgres::ClusterHostType::kMaster,
            "INSERT INTO rate_buckets (key, window_start, count) "
            "VALUES ($1, $2, 1) "
            "ON CONFLICT (key, window_start) "
            "DO UPDATE SET count = rate_buckets.count + 1 "
            "RETURNING count",
            key, window_start);
        const int count = res.Front()[0].As<int>();

        // Opportunistic, low-probability cleanup — same "don't pay this
        // cost on every call" reasoning InProcessRateLimitStore's GC uses,
        // just probabilistic instead of time-since-last-GC since there's no
        // single shared clock check to gate on across replicas here.
        if (userver::utils::RandRange(std::uint64_t{128}) == 0) {
            cluster_->Execute(
                userver::storages::postgres::ClusterHostType::kMaster,
                "DELETE FROM rate_buckets WHERE window_start < $1",
                StaleCutoff(now_unix, window_seconds));
        }

        return count <= max_per_window;
    } catch (const std::exception& ex) {
        // Fail open — see this file's header comment.
        LOG_WARNING() << "[PostgresRateLimitStore] Allow(" << key
                      << ") failed, failing open: " << ex.what();
        return true;
    }
}

int PostgresRateLimitStore::Remaining(const std::string& key, int max_per_window,
                                      std::chrono::seconds window) const {
    const int  window_seconds = static_cast<int>(window.count());
    const auto now_unix       = NowUnix();
    const auto window_start   = WindowStart(now_unix, window_seconds);

    try {
        auto res = cluster_->Execute(
            userver::storages::postgres::ClusterHostType::kSlave,
            "SELECT count FROM rate_buckets WHERE key = $1 AND window_start = $2",
            key, window_start);
        if (res.IsEmpty()) return max_per_window;
        const int count = res.Front()[0].As<int>();
        return count >= max_per_window ? 0 : max_per_window - count;
    } catch (const std::exception& ex) {
        LOG_WARNING() << "[PostgresRateLimitStore] Remaining(" << key
                      << ") failed, reporting full allowance: " << ex.what();
        return max_per_window;
    }
}

} // namespace six_feat
