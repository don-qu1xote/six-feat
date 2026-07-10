#pragma once

// ════════════════════════════════════════════════════════════════════════════
// genius_gateway_client.hpp  —  IDEA-46
//
// GeniusGatewayClient replaces the in-process GeniusGateway component for
// six_feat and six_feat_enrichment. It exposes the exact same public
// interface CollabService / graph_handler / search_handler / EnrichmentWorker
// already depend on (FetchArtistById, FetchSongList, FetchSongDetail,
// ResolveCandidates, SongsLimitFg/Bg, MatchThreshold) but implements it as a
// secret-gated HTTP POST to the standalone six-feat-genius-gateway service
// (IDEA-45: POST /internal/genius/{artist,song-list,song,candidates}) instead
// of talking to the Genius API directly.
//
// All resilience (CircuitBreaker, lane rate-limiting/backoff) now lives in
// six-feat-genius-gateway itself — this client is a thin, stateless HTTP
// caller. Non-2xx responses are surfaced as the same six_feat::GeniusHttpError
// the old GeniusGateway threw, carrying the exact status code the gateway
// service returned, so genius_error_mapping.cpp's MapGeniusHttpError and the
// existing 401 (re-login) handling in callers keep working unchanged.
// ════════════════════════════════════════════════════════════════════════════

#include "domain/domain_types.hpp"
#include "core/resilience.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class GeniusGatewayClient final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "genius-gateway-client";

    GeniusGatewayClient(const userver::components::ComponentConfig&  config,
                        const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Public API — identical surface to the retired GeniusGateway ────────

    std::vector<Candidate>
    ResolveCandidates(const std::string& query,
                      const std::string& user_token) const;

    std::optional<ArtistRef>
    FetchArtistById(std::int64_t       id,
                    Lane               lane,
                    const std::string& user_token) const;

    std::vector<std::int64_t>
    FetchSongList(std::int64_t       artist_id,
                  int                limit,
                  Lane               lane,
                  const std::string& user_token) const;

    std::optional<SongRecord>
    FetchSongDetail(std::int64_t       song_id,
                    Lane               lane,
                    const std::string& user_token) const;

    double MatchThreshold() const { return match_threshold_; }
    int    SongsLimitFg()   const { return songs_limit_fg_; }
    int    SongsLimitBg()   const { return songs_limit_bg_; }

private:
    // POSTs `body` (with the shared secret + request-id headers) to
    // base_url_ + path and returns the parsed JSON response.
    // Throws GeniusHttpError{status, ...} on any non-2xx response or on
    // network/timeout failure (mapped to a 502), so every caller only ever
    // needs to handle one exception type — exactly the GeniusGateway contract.
    userver::formats::json::Value
    PostInternal(const std::string&                     path,
                userver::formats::json::ValueBuilder& body) const;

    userver::clients::http::Client& http_client_;
    const std::string               base_url_;
    const std::string               shared_secret_;
    const std::chrono::milliseconds timeout_;
    const int                       songs_limit_fg_;
    const int                       songs_limit_bg_;
    const double                    match_threshold_;
};

} // namespace six_feat
