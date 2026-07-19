#include "internal_handlers.hpp"
#include "core/internal_auth.hpp"
#include "core/request_id.hpp"
#include "core/resilience.hpp"
#include "core/security_headers.hpp"
#include "http/readiness_common.hpp"
#include "schemas/handlers/genius-gateway/artist_handler_schema.hpp"
#include "schemas/handlers/genius-gateway/song_list_handler_schema.hpp"
#include "schemas/handlers/genius-gateway/song_handler_schema.hpp"
#include "schemas/handlers/genius-gateway/candidates_handler_schema.hpp"
#include "schemas/handlers/genius-gateway/readiness_handler_schema.hpp"

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::genius_gateway {

using namespace userver;

namespace {

bool SecretMatches(const server::http::HttpRequest& request,
                    const std::string&               expected) {
    const std::string& given = request.GetHeader(internal_api::kSecretHeader);
    return internal_api::SecretEquals(given, expected);
}

std::string ErrorJson(const std::string& error) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["error"] = error;
    return formats::json::ToString(b.ExtractValue());
}

// Genius errors are never collapsed into 200 here — the caller (the next
// task's main/enrichment integration) needs the real HTTP status to tell
// 401 (relogin) apart from 503 (CB open / Genius down), 502 (other genius
// error) and 499 (client cancelled upstream). The GeniusHttpError status
// code is passed straight through as this handler's HTTP status.
std::string GeniusErrorCode(int status_code) {
    switch (status_code) {
        case 401: return "token_invalid";
        case 499: return "client_cancelled";
        case 503: return "genius_unavailable";
        default:  return "genius_error";
    }
}

std::string HandleGeniusError(server::http::HttpResponse& resp,
                              const GeniusHttpError&       e) {
    resp.SetStatus(
        static_cast<server::http::HttpStatus>(e.status_code));
    return ErrorJson(GeniusErrorCode(e.status_code));
}

std::optional<Lane> ParseLane(const std::string& raw) {
    if (raw == "foreground") return Lane::Foreground;
    if (raw == "background") return Lane::Background;
    return std::nullopt;
}

formats::json::ValueBuilder ArtistJson(const ArtistRef& a) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["id"]    = a.id;
    b["name"]  = a.name;
    b["image"] = a.image;
    b["url"]   = a.url;
    return b;
}

} // namespace

// ── ArtistHandler ────────────────────────────────────────────────────────

ArtistHandler::ArtistHandler(const components::ComponentConfig&  config,
                              const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , gateway_(context.FindComponent<GeniusGateway>())
    , shared_secret_(internal_api::SharedSecretFromEnv())
{}

std::string ArtistHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);

    auto& resp = request.GetHttpResponse();
    resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    if (!SecretMatches(request, shared_secret_)) {
        resp.SetStatus(server::http::HttpStatus::kUnauthorized);
        return ErrorJson("unauthorized");
    }

    std::int64_t id = 0;
    std::string  lane_raw, user_token;
    try {
        const auto body = formats::json::FromString(request.RequestBody());
        id         = body["id"].As<std::int64_t>(0);
        lane_raw   = body["lane"].As<std::string>("");
        user_token = body["user_token"].As<std::string>("");
    } catch (const std::exception&) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("invalid JSON body");
    }

    const auto lane = ParseLane(lane_raw);
    if (id <= 0 || !lane || user_token.empty()) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("id, lane (foreground|background) and user_token are required");
    }

    try {
        const auto found = gateway_.FetchArtistById(id, *lane, user_token);
        formats::json::ValueBuilder b(formats::json::Type::kObject);
        if (!found) {
            b["found"] = false;
            return formats::json::ToString(b.ExtractValue());
        }
        b["found"] = true;
        b["id"]    = found->id;
        b["name"]  = found->name;
        b["image"] = found->image;
        b["url"]   = found->url;
        return formats::json::ToString(b.ExtractValue());
    } catch (const GeniusHttpError& e) {
        return HandleGeniusError(resp, e);
    }
}

yaml_config::Schema ArtistHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kArtistHandlerSchema);
}

// ── SongListHandler ──────────────────────────────────────────────────────

SongListHandler::SongListHandler(const components::ComponentConfig&  config,
                                  const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , gateway_(context.FindComponent<GeniusGateway>())
    , shared_secret_(internal_api::SharedSecretFromEnv())
{}

std::string SongListHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);

    auto& resp = request.GetHttpResponse();
    resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    if (!SecretMatches(request, shared_secret_)) {
        resp.SetStatus(server::http::HttpStatus::kUnauthorized);
        return ErrorJson("unauthorized");
    }

    std::int64_t artist_id = 0;
    int          limit     = 0;
    std::string  lane_raw, user_token;
    try {
        const auto body = formats::json::FromString(request.RequestBody());
        artist_id  = body["artist_id"].As<std::int64_t>(0);
        limit      = body["limit"].As<int>(0);
        lane_raw   = body["lane"].As<std::string>("");
        user_token = body["user_token"].As<std::string>("");
    } catch (const std::exception&) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("invalid JSON body");
    }

    const auto lane = ParseLane(lane_raw);
    if (artist_id <= 0 || !lane || user_token.empty()) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("artist_id, lane (foreground|background) and user_token are required");
    }

    if (limit <= 0) {
        limit = (*lane == Lane::Foreground) ? gateway_.SongsLimitFg()
                                             : gateway_.SongsLimitBg();
    }

    try {
        const auto ids = gateway_.FetchSongList(artist_id, limit, *lane, user_token);
        formats::json::ValueBuilder b(formats::json::Type::kObject);
        formats::json::ValueBuilder ids_arr(formats::json::Type::kArray);
        for (const auto sid : ids) ids_arr.PushBack(sid);
        b["song_ids"] = std::move(ids_arr);
        return formats::json::ToString(b.ExtractValue());
    } catch (const GeniusHttpError& e) {
        return HandleGeniusError(resp, e);
    }
}

yaml_config::Schema SongListHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kSongListHandlerSchema);
}

// ── SongHandler ───────────────────────────────────────────────────────────

SongHandler::SongHandler(const components::ComponentConfig&  config,
                          const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , gateway_(context.FindComponent<GeniusGateway>())
    , shared_secret_(internal_api::SharedSecretFromEnv())
{}

std::string SongHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);

    auto& resp = request.GetHttpResponse();
    resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    if (!SecretMatches(request, shared_secret_)) {
        resp.SetStatus(server::http::HttpStatus::kUnauthorized);
        return ErrorJson("unauthorized");
    }

    std::int64_t song_id = 0;
    std::string  lane_raw, user_token;
    try {
        const auto body = formats::json::FromString(request.RequestBody());
        song_id    = body["song_id"].As<std::int64_t>(0);
        lane_raw   = body["lane"].As<std::string>("");
        user_token = body["user_token"].As<std::string>("");
    } catch (const std::exception&) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("invalid JSON body");
    }

    const auto lane = ParseLane(lane_raw);
    if (song_id <= 0 || !lane || user_token.empty()) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("song_id, lane (foreground|background) and user_token are required");
    }

    try {
        const auto found = gateway_.FetchSongDetail(song_id, *lane, user_token);
        formats::json::ValueBuilder b(formats::json::Type::kObject);
        if (!found) {
            b["found"] = false;
            return formats::json::ToString(b.ExtractValue());
        }
        b["found"] = true;
        formats::json::ValueBuilder s(formats::json::Type::kObject);
        s["id"]         = found->id;
        s["title"]      = found->title;
        s["popularity"] = found->popularity;
        formats::json::ValueBuilder credits(formats::json::Type::kArray);
        for (const auto& c : found->credits) {
            formats::json::ValueBuilder cb(formats::json::Type::kObject);
            cb["artist"] = ArtistJson(c.artist);
            cb["role"]   = c.role;
            credits.PushBack(cb.ExtractValue());
        }
        s["credits"] = std::move(credits);
        b["song"] = std::move(s);
        return formats::json::ToString(b.ExtractValue());
    } catch (const GeniusHttpError& e) {
        return HandleGeniusError(resp, e);
    }
}

yaml_config::Schema SongHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kSongHandlerSchema);
}

// ── CandidatesHandler ────────────────────────────────────────────────────

CandidatesHandler::CandidatesHandler(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , gateway_(context.FindComponent<GeniusGateway>())
    , shared_secret_(internal_api::SharedSecretFromEnv())
{}

std::string CandidatesHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);

    auto& resp = request.GetHttpResponse();
    resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    if (!SecretMatches(request, shared_secret_)) {
        resp.SetStatus(server::http::HttpStatus::kUnauthorized);
        return ErrorJson("unauthorized");
    }

    std::string query, user_token;
    try {
        const auto body = formats::json::FromString(request.RequestBody());
        query      = body["query"].As<std::string>("");
        user_token = body["user_token"].As<std::string>("");
    } catch (const std::exception&) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("invalid JSON body");
    }

    if (query.empty() || user_token.empty()) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("query and user_token are required");
    }

    try {
        const auto candidates = gateway_.ResolveCandidates(query, user_token);
        formats::json::ValueBuilder b(formats::json::Type::kObject);
        formats::json::ValueBuilder arr(formats::json::Type::kArray);
        for (const auto& c : candidates) {
            formats::json::ValueBuilder cb(formats::json::Type::kObject);
            cb["id"]    = c.id;
            cb["name"]  = c.name;
            cb["image"] = c.image;
            cb["url"]   = c.url;
            cb["score"] = c.score;
            arr.PushBack(cb.ExtractValue());
        }
        b["candidates"] = std::move(arr);
        return formats::json::ToString(b.ExtractValue());
    } catch (const GeniusHttpError& e) {
        return HandleGeniusError(resp, e);
    }
}

yaml_config::Schema CandidatesHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kCandidatesHandlerSchema);
}

// ── ReadinessHandler ─────────────────────────────────────────────────────

ReadinessHandler::ReadinessHandler(const components::ComponentConfig&  config,
                                    const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , gateway_(context.FindComponent<GeniusGateway>())
{}

std::string ReadinessHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    // See this class's own header comment for why Open/HalfOpen gates
    // readiness here (unlike six-feat, which has an L1 cache to fall back
    // on and deliberately does NOT gate on Genius reachability).
    const auto cb_state = gateway_.CbState();
    const bool cb_ok     = cb_state == CircuitBreaker::State::Closed;

    const std::vector<ReadinessCheck> checks{
        {"circuit_breaker", cb_ok, CircuitBreaker::ToString(cb_state)},
    };

    return BuildReadinessBody(request, checks);
}

yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGeniusGatewayReadinessHandlerSchema);
}

} // namespace six_feat::genius_gateway
