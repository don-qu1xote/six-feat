#pragma once

// Internal HTTP API for six-feat-genius-gateway (IDEA-45). Not meant for
// external clients — every handler requires the X-Internal-Secret header to
// match ENRICHMENT_INTERNAL_SECRET (see src/internal_auth.hpp, reused here
// as the shared inter-service secret for the whole internal mesh).
//
// Every call is made on behalf of a signed-in user (ТЗ-6): user_token and
// lane ("foreground"|"background") are required on every body below —
// there is no server-level Genius credential.

#include "genius/genius_gateway.hpp"

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::genius_gateway {

// POST /internal/genius/artist
// Body: {"id": <int64>, "lane": "foreground"|"background", "user_token": <string>}
// 200: {"found": bool, "id"?, "name"?, "image"?, "url"?}
class ArtistHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-genius-artist";

    ArtistHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    GeniusGateway&    gateway_;
    const std::string shared_secret_;
};

// POST /internal/genius/song-list
// Body: {"artist_id": <int64>, "limit"?: <int>, "lane": "foreground"|"background",
//        "user_token": <string>}
// 200: {"song_ids": [<int64>, ...]}
class SongListHandler final
    : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-genius-song-list";

    SongListHandler(const userver::components::ComponentConfig&  config,
                    const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    GeniusGateway&    gateway_;
    const std::string shared_secret_;
};

// POST /internal/genius/song
// Body: {"song_id": <int64>, "lane": "foreground"|"background", "user_token": <string>}
// 200: {"found": bool, "song"?: {"id","title","popularity",
//        "credits": [{"artist": {"id","name","image","url"}, "role"}, ...]}}
class SongHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-genius-song";

    SongHandler(const userver::components::ComponentConfig&  config,
               const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    GeniusGateway&    gateway_;
    const std::string shared_secret_;
};

// POST /internal/genius/candidates
// Body: {"query": <string>, "user_token": <string>}
// 200: {"candidates": [{"id","name","image","url","score"}, ...]}
class CandidatesHandler final
    : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-genius-candidates";

    CandidatesHandler(const userver::components::ComponentConfig&  config,
                      const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    GeniusGateway&    gateway_;
    const std::string shared_secret_;
};

// GET /readyz — unauthenticated readiness probe. [SF-INF-03] Unified body
// shape (six_feat::ReadinessCheck/BuildReadinessBody, see
// libs/six-feat-common/src/http/readiness_common.hpp). This service has no
// Postgres of its own (it's a pure API proxy) — its one dependency worth
// reporting is the shared CircuitBreaker's state against Genius itself.
// Unlike six-feat (whose L1 cache keeps serving reads through a Genius
// outage, so an open CB there is explicitly NOT a readiness failure — see
// services/six-feat/src/http/readiness_handler.hpp), THIS service has no
// cache to fall back on: every one of its handlers proxies straight
// through to Genius, so an open circuit breaker really does mean it can't
// serve (most of) its traffic — hence gating (ok=false) here, not merely
// informational.
class ReadinessHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-readyz";

    ReadinessHandler(const userver::components::ComponentConfig&  config,
                      const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    GeniusGateway& gateway_;
};

} // namespace six_feat::genius_gateway
