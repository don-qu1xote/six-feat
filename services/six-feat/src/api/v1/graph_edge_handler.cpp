#include "graph_edge_handler.hpp"

#include "auth/api_key_auth.hpp"

#include "schemas/handlers/six-feat/graph_edge_handler_schema.hpp"

#include <charconv>
#include <optional>
#include <six-feat-auth-lib/user_identity.hpp>
#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-domain/role_mask.hpp>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <utility>
#include <vector>

#include "application/edge_aggregation.hpp"
#include "infrastructure/genius_error_mapping.hpp"

namespace six_feat {

using namespace userver;

namespace {

std::string ErrorEdge(const std::string& message) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"graph_edge"};
  b["error"] = message;
  b["request_id"] = CurrentRequestId();
  return formats::json::ToString(b.ExtractValue());
}

std::string RateLimitKey(const server::http::HttpRequest& request, const auth::OAuthConfig& oauth) {
  std::string token = auth::ExtractToken(request, oauth.SessionKey());
  if (!token.empty()) return token;
  return request.GetRemoteAddress().PrimaryAddressString();
}

bool ParseId(const std::string& param, std::int64_t& out) {
  if (param.empty()) return false;
  const char* begin = param.data();
  const char* end = param.data() + param.size();
  auto [ptr, ec] = std::from_chars(begin, end, out);
  return ec == std::errc{} && ptr == end;
}

}  // namespace

GraphEdgeHandler::GraphEdgeHandler(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      service_(context.FindComponent<CollabService>()),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      api_key_store_(context.FindComponent<auth::ApiKeyStore>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()),
      rate_limit_(
          "graph-edge", 50, 1, context.FindComponent<RateLimitStoreComponent>().MakeStore()) {}

std::string GraphEdgeHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                 server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  std::string user_token;
  std::string limit_key;
  int rl_max = rate_limit_.Limit();
  std::chrono::seconds rl_window = rate_limit_.Window();

  const auto api_key_check = CheckApiKeyHeader(request, api_key_store_);
  if (api_key_check.provided) {
    if (!api_key_check.identity) {
      response.SetStatus(server::http::HttpStatus::kUnauthorized);
      return ErrorEdge("invalid_api_key");
    }
    const auto& identity = *api_key_check.identity;
    user_token = identity.genius_token;
    limit_key = "apikey:" + std::to_string(identity.id);
    const auto tier = ResolveRateTier(identity.rate_tier);
    rl_max = tier.max_per_window;
    rl_window = tier.window;
  } else {
    limit_key = RateLimitKey(request, oauth_);
  }

  if (!rate_limit_.AllowWithTier(limit_key, rl_max, rl_window)) {
    response.SetStatus(server::http::HttpStatus::kTooManyRequests);
    response.SetHeader(std::string{"Retry-After"}, std::string{"1"});
    response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rl_max));
    response.SetHeader(std::string{"X-RateLimit-Remaining"}, std::string{"0"});
    return ErrorEdge("rate limit exceeded");
  }
  response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rl_max));
  response.SetHeader(std::string{"X-RateLimit-Remaining"},
                     std::to_string(rate_limit_.RemainingWithTier(limit_key, rl_max, rl_window)));

  bool enrichment_enabled = true;
  if (user_token.empty()) {
    const auto session = auth::RequireFullSession(request, oauth_);
    if (!session) {
      return ErrorEdge("not_authenticated");
    }
    enrichment_enabled = user_provider_tokens_.GetEnrichmentEnabled(auth::SessionUserId(*session));
    const auto connected = user_provider_tokens_.Get(auth::SessionUserId(*session), "genius");
    user_token = auth::GeniusTokenForSession(*session, connected);
  }

  std::int64_t from_id = 0;
  std::int64_t to_id = 0;
  if (!ParseId(request.GetArg("from"), from_id) || !ParseId(request.GetArg("to"), to_id)) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorEdge("'from' and 'to' must be numeric artist ids");
  }
  if (from_id == to_id) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorEdge("'from' and 'to' must differ");
  }

  const RoleMask mask = ParseRoleMask(request.GetArg("roles"));

  std::optional<ArtistRef> from_ref = service_.CachedSeed(from_id);
  if (!from_ref) {
    if (user_token.empty()) {
      response.SetStatus(server::http::HttpStatus::kUnprocessableEntity);
      return ErrorEdge("no_genius_token");
    }
    try {
      from_ref = service_.ResolveById(from_id, user_token);
    } catch (const GeniusHttpError& e) {
      MapGeniusHttpError(e, response);
      return ErrorEdge("could not reach Genius");
    }
  }
  if (!from_ref) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return ErrorEdge("artist id not found: " + std::to_string(from_id));
  }

  ArtistSongs data;
  try {
    data = service_.BuildRadialGraph(*from_ref, user_token, std::nullopt, enrichment_enabled);
  } catch (const GeniusHttpError& e) {
    MapGeniusHttpError(e, response);
    return ErrorEdge("could not reach Genius");
  }

  const auto aggregation = AggregateEdges(data, from_ref->id, mask);
  const auto it = aggregation.by_neighbour.find(to_id);
  if (it == aggregation.by_neighbour.end()) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return ErrorEdge("no edge between the given artists");
  }

  const auto collaborations = SortedByPopularity(it->second.collaborations);

  formats::json::ValueBuilder out(formats::json::Type::kObject);
  out["type"] = std::string{"graph_edge"};
  out["from"] = from_ref->id;
  out["to"] = to_id;
  out["collaboration_count"] = it->second.weight;
  out["dominant_role"] = it->second.dominant_role;

  formats::json::ValueBuilder arr(formats::json::Type::kArray);
  for (const auto& c : collaborations) {
    formats::json::ValueBuilder item(formats::json::Type::kObject);
    item["song"] = c.song;
    item["popularity"] = c.popularity;
    formats::json::ValueBuilder rb(formats::json::Type::kArray);
    for (const auto& r : c.roles) rb.PushBack(r);
    item["roles"] = std::move(rb);
    arr.PushBack(std::move(item));
  }
  out["collaborations"] = std::move(arr);

  return formats::json::ToString(out.ExtractValue());
}

yaml_config::Schema GraphEdgeHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGraphEdgeHandlerSchema);
}

}  // namespace six_feat
