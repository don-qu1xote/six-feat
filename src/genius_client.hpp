#pragma once

// ════════════════════════════════════════════════════════════════════════════
// genius_client.hpp  —  iteration 4
//
// GeniusClient is a userver ComponentBase that owns:
//   • The LRU artist-data cache (role-agnostic ArtistSongs)
//   • RateLimiter + CircuitBreaker (resilience, from iteration 3)
//   • GeniusGet() — the single resilient HTTP entry point
//   • ResolveCandidates / FetchArtistById / GetOrFetchArtistSongs
//
// Both GraphHandler and PathHandler inject GeniusClient via ComponentContext.
// This eliminates the code duplication that existed when each handler owned
// its own cache and resilience objects.
//
// Why ComponentBase and not a plain shared_ptr?
//   userver's DI container (ComponentContext) guarantees correct construction
//   order, lifecycle management, and graceful shutdown.  It also lets us
//   read the component's own config section from static_config.yaml without
//   the caller needing to pass it down manually.
// ════════════════════════════════════════════════════════════════════════════

#include <atomic>
#include <chrono>
#include <cstdint>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// ════════════════════════════════════════════════════════════════════════════
// Domain types  (canonical definitions — included everywhere via this header)
// ════════════════════════════════════════════════════════════════════════════

struct ArtistRef {
    std::int64_t id{0};
    std::string  name;
    std::string  image;
    std::string  url;
};

struct TrackCredit {
    ArtistRef   artist;
    std::string role;   // "featured" | "producer" | "writer" | "primary"
};

struct SongRecord {
    std::string              title;
    std::vector<TrackCredit> credits;
};

struct ArtistSongs {
    ArtistRef               seed;
    std::vector<SongRecord> songs;
};

struct Candidate {
    std::int64_t id{0};
    std::string  name;
    std::string  image;
    std::string  url;
    double       score{0.0};
};

struct RoleMask {
    bool primary{true};
    bool producer{true};
    bool writer{true};
    bool featured{true};
};

// ════════════════════════════════════════════════════════════════════════════
// LruCache<K,V>  (unchanged from iteration 3, now lives here)
// ════════════════════════════════════════════════════════════════════════════

template <typename K, typename V>
class LruCache {
public:
    using Clock    = std::chrono::steady_clock;
    using Duration = std::chrono::seconds;

    explicit LruCache(std::size_t max_size, Duration ttl)
        : max_size_(max_size), ttl_(ttl) {}

    std::optional<V> Get(const K& key) {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it == index_.end()) return std::nullopt;
        if (IsExpired(it->second->expires_at)) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return it->second->value;
    }

    // Returns stale (expired) data rather than nullopt — CB fallback.
    std::optional<V> GetStale(const K& key) {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it == index_.end()) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return it->second->value;
    }

    void Put(const K& key, V value) {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it != index_.end()) {
            it->second->value      = std::move(value);
            it->second->expires_at = Clock::now() + ttl_;
            list_.splice(list_.begin(), list_, it->second);
            return;
        }
        if (list_.size() >= max_size_) {
            index_.erase(list_.back().key);
            list_.pop_back();
        }
        list_.push_front(Entry{key, std::move(value), Clock::now() + ttl_});
        index_[key] = list_.begin();
    }

    std::size_t Size() const {
        std::lock_guard lock(mu_);
        return list_.size();
    }

private:
    struct Entry {
        K                              key;
        V                              value;
        std::chrono::time_point<Clock> expires_at;
    };
    static bool IsExpired(const std::chrono::time_point<Clock>& tp) {
        return Clock::now() >= tp;
    }
    mutable std::mutex mu_;
    std::size_t        max_size_;
    Duration           ttl_;
    std::list<Entry>   list_;
    std::unordered_map<K, typename std::list<Entry>::iterator> index_;
};

// ════════════════════════════════════════════════════════════════════════════
// RateLimiter  (moved here from graph_handler.hpp, unchanged)
// ════════════════════════════════════════════════════════════════════════════

class RateLimiter {
public:
    static constexpr int kMinRemaining = 2;
    void Update(int remaining, std::int64_t reset_unix);
    void WaitIfNeeded() const;
    int  Remaining() const;
private:
    mutable std::mutex  mu_;
    int          remaining_{-1};
    std::int64_t reset_unix_{0};
};

// ════════════════════════════════════════════════════════════════════════════
// CircuitBreaker  (moved here, unchanged)
// ════════════════════════════════════════════════════════════════════════════

class CircuitBreaker {
public:
    enum class State : int { Closed = 0, Open = 1, HalfOpen = 2 };

    explicit CircuitBreaker(int failure_threshold,
                            std::chrono::seconds open_duration)
        : failure_threshold_(failure_threshold),
          open_duration_(open_duration) {}

    bool  AllowRequest();
    void  RecordSuccess();
    void  RecordFailure();
    State CurrentState() const;

private:
    void Trip();
    void Reset();

    const int                  failure_threshold_;
    const std::chrono::seconds open_duration_;
    mutable std::mutex         mu_;
    std::atomic<State>         state_{State::Closed};
    int                        consecutive_failures_{0};
    std::chrono::steady_clock::time_point trip_time_{};
};

// ════════════════════════════════════════════════════════════════════════════
// GeniusHttpError
// ════════════════════════════════════════════════════════════════════════════

struct GeniusHttpError : std::runtime_error {
    int status_code;
    explicit GeniusHttpError(int code, const std::string& msg)
        : std::runtime_error(msg), status_code(code) {}
};

// ════════════════════════════════════════════════════════════════════════════
// GeniusClient — shared userver component
//
// Owns the cache, resilience objects, and all Genius I/O.
// GraphHandler and PathHandler both hold a reference to it.
// ════════════════════════════════════════════════════════════════════════════

class GeniusClient final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "genius-client";

    GeniusClient(const userver::components::ComponentConfig&  config,
                 const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Public API ───────────────────────────────────────────────────────

    /// Fuzzy name search → ranked Candidates.  Throws GeniusHttpError.
    std::vector<Candidate> ResolveCandidates(const std::string& query) const;

    /// Fetch by numeric id (for ?id= / shareable URLs).
    std::optional<ArtistRef> FetchArtistById(std::int64_t id) const;

    /// Cache-first fetch of raw song data for one artist.
    /// Falls back to stale cache if the CircuitBreaker is open.
    ArtistSongs GetOrFetchArtistSongs(const ArtistRef& seed) const;

    /// Check whether we already have (fresh or stale) data for an artist_id.
    bool HasCached(std::int64_t id) const;

    // Expose config values needed by handlers.
    double      MatchThreshold()  const { return match_threshold_; }
    int         SongsLimit()      const { return songs_limit_; }
    std::string GeniusBaseUrl()   const { return genius_base_url_; }

private:
    std::string  GeniusGet(const std::string& url) const;
    ArtistSongs  FetchArtistSongs(const ArtistRef& seed) const;

    userver::clients::http::Client& http_client_;
    const std::string               genius_token_;
    const std::string               genius_base_url_;
    const int                       songs_limit_;
    const double                    match_threshold_;

    mutable RateLimiter    rate_limiter_;
    mutable CircuitBreaker circuit_breaker_;

    const int                      backoff_max_attempts_;
    const std::chrono::milliseconds backoff_base_ms_;
    const std::chrono::milliseconds backoff_cap_ms_;

    mutable LruCache<std::int64_t, ArtistSongs> artist_cache_;
};

} // namespace six_feat
