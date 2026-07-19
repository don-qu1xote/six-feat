// ════════════════════════════════════════════════════════════════════════════
// status_handler.cpp  —  iteration 6
//
// Returns enrichment progress for one artist so the frontend poller can
// decide when to refresh the graph.
// ════════════════════════════════════════════════════════════════════════════

#include "http/status_handler.hpp"
#include "core/request_id.hpp"
#include "schemas/handlers/six-feat/status_handler_schema.hpp"

#include <stdexcept>
#include <string>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

// [SF-API-06] Same id already stamped on the X-Request-Id response header/
// log tags by EnsureRequestId (called inside Prologue(), before any of this
// function's call sites) — not recomputed, just surfaced so a client can
// hand it back for support. Built via ValueBuilder (not raw string
// concatenation) since an incoming X-Request-Id header is attacker-
// controlled and must be JSON-escaped.
std::string ErrorJson(const std::string& code) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["error"]      = code;
    b["request_id"] = CurrentRequestId();
    return formats::json::ToString(b.ExtractValue());
}

} // namespace

StatusHandler::StatusHandler(const components::ComponentConfig&  config,
                              const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context,
                                context.FindComponent<auth::OAuthConfig>())
    , store_(context.FindComponent<PersistentStore>())
    , enrichment_(context.FindComponent<EnrichmentClient>())
{}

std::string StatusHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*ctx*/) const
{
    // [F-29] Same policy as graph/path: no session, no data. Anonymous
    // callers were previously able to enumerate artist_id via this endpoint.
    if (!Prologue(request)) {
        return ErrorJson("not_authenticated");
    }

    const auto& id_str = request.GetArg("id");
    if (id_str.empty()) {
        request.GetHttpResponse().SetStatus(
            server::http::HttpStatus::kBadRequest);
        return ErrorJson("missing ?id=<artist_id>");
    }

    std::int64_t artist_id = 0;
    try {
        std::size_t pos = 0;
        artist_id = std::stoll(id_str, &pos);
        // Reject trailing garbage like "123abc" — stoll stops at the first
        // non-digit, pos < size means characters remain after the number.
        if (pos != id_str.size()) {
            request.GetHttpResponse().SetStatus(
                server::http::HttpStatus::kBadRequest);
            return ErrorJson("id must be an integer");
        }
    } catch (...) {
        request.GetHttpResponse().SetStatus(
            server::http::HttpStatus::kBadRequest);
        return ErrorJson("id must be an integer");
    }

    request.GetHttpResponse().SetContentType(
        http::ContentType("application/json"));

    // Query depth, song_count and last_fetch_ts from L1.
    const auto state = store_.GetFetchState(artist_id);

    const int depth           = static_cast<int>(state.depth);
    const int song_count      = state.song_count;
    const std::int64_t ts     = state.last_fetch_ts;
    const bool enriching      = enrichment_.IsEnriching(artist_id);

    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["artist_id"]     = artist_id;
    b["depth"]         = depth;
    b["song_count"]    = song_count;
    b["last_fetch_ts"] = ts;
    b["enriching"]     = enriching;

    return formats::json::ToString(b.ExtractValue());
}

// static
userver::yaml_config::Schema StatusHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<HttpHandlerBase>(kStatusHandlerSchema);
}

} // namespace six_feat
