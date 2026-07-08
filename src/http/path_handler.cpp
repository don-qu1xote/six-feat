#include "http/path_handler.hpp"
#include "storage/analytics.hpp"
#include "genius/genius_error_mapping.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "domain/role_mask.hpp"

#include <algorithm>
#include <charconv>
#include <string>
#include <unordered_set>
#include <variant>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/deadline.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

// Foreground request budget for a path search: how long HandleRequestThrow
// waits before giving up and returning "deadline_exceeded" while background
// enrichment keeps running.
constexpr std::chrono::seconds kFgPathDeadline{25};

// code/msg have distinct call-site meanings (an error code literal vs. a
// human-readable message); swapping them is not a realistic mistake at any
// of this function's call sites.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
std::string ErrorJson(const std::string& code, const std::string& msg) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["type"]    = std::string{"path"};
    b["error"]   = code;
    b["message"] = msg;
    return formats::json::ToString(b.ExtractValue());
}

// Sets `resp`'s status via the shared GeniusHttpError mapping and renders it
// into path's error body format.
std::string GeniusErrorJson(const GeniusHttpError&      e,
                             server::http::HttpResponse& resp) {
    const std::string code = MapGeniusHttpError(e, resp);
    if (code == "token_invalid") {
        return ErrorJson("token_invalid",
            "Your Genius token is no longer valid — please sign in again.");
    }
    if (code == "client_cancelled") {
        return ErrorJson("client_cancelled", "client request cancelled");
    }
    return ErrorJson("genius_error", e.what());
}

std::string RateLimitKey(const server::http::HttpRequest& request,
                          const auth::OAuthConfig&         oauth) {
    std::string token = auth::ExtractToken(request, oauth.SessionKey());
    if (!token.empty()) return token;
    return request.GetRemoteAddress().PrimaryAddressString();
}

// [F-5] A parameter counts as a numeric id ONLY if the entire token is
// digits (std::from_chars consumes the whole string_view). "50 Cent" etc.
// no longer misparse as id=50.
bool IsStrictNumericId(const std::string& param, std::int64_t& out_id) {
    if (param.empty()) return false;
    const char* begin = param.data();
    const char* end   = param.data() + param.size();
    auto [ptr, ec] = std::from_chars(begin, end, out_id);
    return ec == std::errc{} && ptr == end;
}

std::optional<ArtistRef>
ResolveEndpoint(CollabService& svc, const std::string& param,
                std::string& out_error, const std::string& user_token) {
    if (param.empty()) { out_error = "missing parameter"; return std::nullopt; }

    // Numeric id?
    std::int64_t id = 0;
    if (IsStrictNumericId(param, id)) {
        auto ref = svc.ResolveById(id, user_token);
        if (!ref) { out_error = "artist id not found: " + param; return std::nullopt; }
        return ref;
    }

    // Fuzzy name.
    try {
        auto resolved = svc.ResolveByName(param, user_token);
        if (std::holds_alternative<ArtistRef>(resolved))
            return std::get<ArtistRef>(resolved);
        const auto& ar = std::get<AmbiguousResult>(resolved);
        if (ar.candidates.empty())
            out_error = "artist not found: " + param;
        else
            out_error = "ambiguous artist name: " + param;
        return std::nullopt;
    } catch (const GeniusHttpError&) {
        throw;
    } catch (const std::exception& ex) {
        out_error = ex.what();
        return std::nullopt;
    }
}

} // namespace

PathHandler::PathHandler(const components::ComponentConfig&  config,
                          const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      service_(context.FindComponent<CollabService>()),
      oauth_(context.FindComponent<auth::OAuthConfig>())
{}

std::string PathHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    auto& resp = request.GetHttpResponse();
    resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    const std::string limit_key = RateLimitKey(request, oauth_);
    if (!rate_limit_.Allow(limit_key)) {
        resp.SetStatus(server::http::HttpStatus::kTooManyRequests);
        resp.SetHeader(std::string{"Retry-After"}, std::string{"1"});
        resp.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rate_limit_.Limit()));
        resp.SetHeader(std::string{"X-RateLimit-Remaining"}, std::string{"0"});
        return ErrorJson("rate_limit_exceeded", "rate limit exceeded");
    }
    resp.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rate_limit_.Limit()));
    resp.SetHeader(std::string{"X-RateLimit-Remaining"},
                    std::to_string(rate_limit_.Remaining(limit_key)));

    const auto session = auth::RequireSession(request, oauth_);
    if (!session) {
        return ErrorJson("not_authenticated",
            "Login with Genius to search for collaboration paths.");
    }
    const std::string& user_token = *session;

    const std::string& from_param = request.GetArg("from");
    const std::string& to_param   = request.GetArg("to");
    const RoleMask    mask       = ParseRoleMask(request.GetArg("roles"));

    if (from_param.empty() || to_param.empty()) {
        resp.SetStatus(server::http::HttpStatus::kBadRequest);
        return ErrorJson("bad_request",
                         "'from' and 'to' query parameters are required");
    }

    std::string err;
    std::optional<ArtistRef> from_opt, to_opt;
    try {
        from_opt = ResolveEndpoint(service_, from_param, err, user_token);
        if (!from_opt) {
            resp.SetStatus(server::http::HttpStatus::kNotFound);
            return ErrorJson("resolve_failed", "'from': " + err);
        }
        to_opt = ResolveEndpoint(service_, to_param, err, user_token);
        if (!to_opt) {
            resp.SetStatus(server::http::HttpStatus::kNotFound);
            return ErrorJson("resolve_failed", "'to': " + err);
        }
    } catch (const GeniusHttpError& e) {
        return GeniusErrorJson(e, resp);
    }

    const ArtistRef from_ref = *from_opt;
    const ArtistRef to_ref   = *to_opt;

    if (from_ref.id == to_ref.id) {
        formats::json::ValueBuilder b(formats::json::Type::kObject);
        b["type"] = std::string{"path"};
        b["hops"] = 0;
        auto emit = [](const ArtistRef& r) {
            formats::json::ValueBuilder rb(formats::json::Type::kObject);
            rb["id"] = r.id; rb["name"] = r.name;
            if (!r.image.empty()) rb["image"] = r.image;
            if (!r.url.empty())   rb["url"]   = r.url;
            return rb;
        };
        b["from"]  = emit(from_ref);
        b["to"]    = emit(to_ref);
        formats::json::ValueBuilder p(formats::json::Type::kArray);
        p.PushBack(from_ref.id);
        b["path"]  = std::move(p);
        b["nodes"] = formats::json::ValueBuilder(formats::json::Type::kArray);
        b["edges"] = formats::json::ValueBuilder(formats::json::Type::kArray);
        return formats::json::ToString(b.ExtractValue());
    }

    const auto deadline = engine::Deadline::FromDuration(kFgPathDeadline);

    PathFindResult result;
    try {
        result = service_.FindPath(from_ref, to_ref, mask, deadline, user_token);
    } catch (const GeniusHttpError& e) {
        return GeniusErrorJson(e, resp);
    } catch (const std::exception& ex) {
        resp.SetStatus(server::http::HttpStatus::kInternalServerError);
        return ErrorJson("internal_error", ex.what());
    }

    if (result.ctx.path.empty()) {
        if (result.deadline_exceeded) {
            resp.SetStatus(server::http::HttpStatus::kServiceUnavailable);
            return ErrorJson("deadline_exceeded",
                "Graph too sparse, try again later — background enrichment is running");
        }
        return ErrorJson("no_path",
            "No collaboration path found between '" + from_ref.name +
            "' and '" + to_ref.name + "'.");
    }

    return BuildPathJson(from_ref, to_ref, result.ctx);
}

std::string PathHandler::BuildPathJson(const ArtistRef&    from_ref,
                                        const ArtistRef&    to_ref,
                                        const PathContext&  ctx) const
{
    using namespace formats::json;

    const auto& path      = ctx.path;
    const auto& adj       = ctx.adj;
    const auto& node_info = ctx.node_info;
    const auto& edge_songs= ctx.edge_songs;

    AdjList path_adj;
    for (std::size_t i = 0; i + 1 < path.size(); ++i) {
        const std::int64_t a = path[i], b = path[i + 1];
        int w = 1;
        if (const auto it = adj.find(a); it != adj.end())
            for (const auto& e : it->second)
                if (e.neighbour == b) { w = e.weight; break; }
        path_adj[a].push_back({b, w});
        path_adj[b].push_back({a, w});
    }

    const std::vector<std::int64_t> path_nodes(path.begin(), path.end());
    const auto bc = BetweennessCentrality(path_adj, path_nodes);
    double bc_max = 0.0;
    for (const auto& [id, s] : bc) bc_max = std::max(bc_max, s);

    ValueBuilder root(Type::kObject);
    root["type"] = std::string{"path"};
    root["hops"] = static_cast<int>(path.size()) - 1;

    const auto emit_ref = [](const ArtistRef& r) {
        ValueBuilder b(Type::kObject);
        b["id"] = r.id; b["name"] = r.name;
        if (!r.image.empty()) b["image"] = r.image;
        if (!r.url.empty())   b["url"]   = r.url;
        return b;
    };
    root["from"] = emit_ref(from_ref);
    root["to"]   = emit_ref(to_ref);

    ValueBuilder path_arr(Type::kArray);
    for (const auto id : path) path_arr.PushBack(id);
    root["path"] = std::move(path_arr);

    ValueBuilder nodes_arr(Type::kArray);
    for (const auto id : path_nodes) {
        ValueBuilder nb(Type::kObject);
        nb["id"] = id;
        if (const auto it = node_info.find(id); it != node_info.end()) {
            nb["name"] = it->second.name;
            if (!it->second.image.empty()) nb["image"] = it->second.image;
            if (!it->second.url.empty())   nb["url"]   = it->second.url;
        }
        const double raw = bc.count(id) ? bc.at(id) : 0.0;
        nb["betweenness"]            = raw;
        nb["betweenness_normalised"] = (bc_max > 0.0) ? raw / bc_max : 0.0;
        nb["is_seed"] = (id == from_ref.id || id == to_ref.id);
        nodes_arr.PushBack(std::move(nb));
    }
    root["nodes"] = std::move(nodes_arr);

    ValueBuilder edges_arr(Type::kArray);
    for (std::size_t i = 0; i + 1 < path.size(); ++i) {
        const std::int64_t a = path[i], b = path[i + 1];
        const std::int64_t lo = std::min(a, b), hi = std::max(a, b);
        int w = 1;
        if (const auto it = adj.find(a); it != adj.end())
            for (const auto& e : it->second)
                if (e.neighbour == b) { w = e.weight; break; }
        ValueBuilder eb(Type::kObject);
        eb["from"]   = a;
        eb["to"]     = b;
        eb["weight"] = w;
        std::string dominant_role = "primary";
        if (const auto oit = ctx.edge_dominant_role.find(lo);
                oit != ctx.edge_dominant_role.end()) {
            if (const auto iit = oit->second.find(hi);
                    iit != oit->second.end() && !iit->second.empty()) {
                dominant_role = iit->second;
            }
        }
        eb["dominant_role"] = dominant_role;
        ValueBuilder songs_arr(Type::kArray);
        if (const auto oit = edge_songs.find(lo); oit != edge_songs.end())
            if (const auto iit = oit->second.find(hi); iit != oit->second.end()) {
                std::unordered_set<std::string> seen;
                for (const auto& t : iit->second)
                    if (seen.insert(t).second) songs_arr.PushBack(t);
            }
        eb["songs"] = std::move(songs_arr);
        edges_arr.PushBack(std::move(eb));
    }
    root["edges"] = std::move(edges_arr);

    return formats::json::ToString(root.ExtractValue());
}

yaml_config::Schema PathHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(R"(
type: object
description: Six-degrees pathfinder (iteration 6)
additionalProperties: false
properties: {}
)");
}

} // namespace six_feat
