#pragma once

// ════════════════════════════════════════════════════════════════════════════
// genius_gateway.hpp  —  iteration 6
//
// GeniusGateway is the network layer extracted from GeniusClient.
// It owns NO cache — that responsibility belongs to ArtistRepository.
//
// Responsibilities:
//   • Build and execute authenticated HTTP requests to the Genius API.
//   • Parse raw JSON responses into domain types.
//   • Drive the ResiliencePipeline (CB / CooldownGate / TokenBucket /
//     LaneSemaphore / RateLimiter / exponential backoff) for every call.
//   • Expose per-operation methods (ResolveCandidates, FetchArtistById,
//     FetchSongList, FetchSongDetail) so callers never construct URLs.
//
// What it no longer does (vs iteration 5 GeniusClient):
//   • No LRU cache.
//   • No GetOrFetchArtistSongs — that aggregation moved to ArtistRepository.
//   • No fan-out of song-detail tasks — moved to CollabService / EnrichmentWorker.
//
// Thread / coroutine safety:
//   GeniusGateway is a shared userver component (const methods only from
//   multiple coroutines).  ResiliencePipeline owns all mutable resilience
//   state and is internally coroutine-safe.
// ════════════════════════════════════════════════════════════════════════════

#include "domain_types.hpp"
#include "resilience.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class GeniusGateway final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "genius-gateway";

    GeniusGateway(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Public API ───────────────────────────────────────────────────────────

    // Fuzzy artist search.  Returns up to 8 candidates sorted by similarity.
    // Uses the Foreground lane (interactive, low latency).
    std::vector<Candidate>
    ResolveCandidates(const std::string& query) const;

    // Direct artist lookup by numeric Genius id.
    // Returns nullopt if the artist does not exist (404).
    std::optional<ArtistRef>
    FetchArtistById(std::int64_t id, Lane lane = Lane::Foreground) const;

    // Fetch the list of song ids for an artist (sorted by popularity).
    // `limit` controls per_page (foreground: songs-limit-fg; background: -bg).
    std::vector<std::int64_t>
    FetchSongList(std::int64_t artist_id, int limit, Lane lane) const;

    // Fetch full credits for one song.
    // Returns nullopt on transient errors (caller logs and skips).
    std::optional<SongRecord>
    FetchSongDetail(std::int64_t song_id, Lane lane) const;

    // Config accessors used by CollabService / ArtistRepository.
    double      MatchThreshold()  const { return match_threshold_; }
    int         SongsLimitFg()    const { return songs_limit_fg_; }
    int         SongsLimitBg()    const { return songs_limit_bg_; }
    std::string BaseUrl()         const { return genius_base_url_; }

    // Resilience diagnostics.
    CircuitBreaker::State CbState() const { return pipeline_.CbState(); }

private:
    // Core HTTP + resilience: send authenticated GET, retry on 5xx/network.
    // Throws GeniusHttpError on 4xx or exhausted retries.
    std::string GeniusGet(const std::string& url, Lane lane) const;

    userver::clients::http::Client& http_client_;
    const std::string               genius_token_;
    const std::string               genius_base_url_;
    const int                       songs_limit_fg_;
    const int                       songs_limit_bg_;
    const double                    match_threshold_;
    const int                       backoff_max_attempts_;
    const std::chrono::milliseconds backoff_base_ms_;
    const std::chrono::milliseconds backoff_cap_ms_;

    mutable ResiliencePipeline      pipeline_;
};

} // namespace six_feat
