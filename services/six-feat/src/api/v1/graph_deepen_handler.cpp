#include "graph_deepen_handler.hpp"

#include "http/dto/artist_ref_dto.hpp"
#include "http/dto/graph_edge_dto.hpp"

#include "auth/api_key_auth.hpp"

#include "schemas/handlers/six-feat/graph_deepen_handler_schema.hpp"

#include <algorithm>
#include <six-feat-auth-lib/user_identity.hpp>
#include <six-feat-common/music_source_provider.hpp>
#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-domain/role_mask.hpp>
#include <string>
#include <unordered_map>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

#include "infrastructure/genius_error_mapping.hpp"

namespace six_feat {

using namespace userver;

namespace {

std::string ErrorJson(const std::string& code, const std::string& msg) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"graph_deepen"};
  b["error"] = code;
  b["message"] = msg;
  b["request_id"] = CurrentRequestId();
  b["nodes"] = formats::json::ValueBuilder(formats::json::Type::kArray);
  b["edges"] = formats::json::ValueBuilder(formats::json::Type::kArray);
  return formats::json::ToString(b.ExtractValue());
}

std::string GeniusErrorJson(const GeniusHttpError& e, server::http::HttpResponse& resp) {
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

std::string RateLimitKey(const server::http::HttpRequest& request, const auth::OAuthConfig& oauth) {
  std::string token = auth::ExtractToken(request, oauth.SessionKey());
  if (!token.empty()) return token;
  return request.GetRemoteAddress().PrimaryAddressString();
}

struct NeighbourAgg {
  int weight{0};
  int best_rank{-1};
  std::string dominant_role{"featured"};
  std::string source{"genius_credit"};
  std::vector<std::string> roles;
};

}  // namespace

GraphDeepenHandler::GraphDeepenHandler(const components::ComponentConfig& config,
                                       const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      service_(context.FindComponent<CollabService>()),
      genius_provider_(context.FindComponent<GeniusMusicSourceProvider>()),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      api_key_store_(context.FindComponent<auth::ApiKeyStore>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()),
      rate_limit_(
          "graph-deepen", 20, 60, context.FindComponent<RateLimitStoreComponent>().MakeStore()) {}

std::string GraphDeepenHandler::HandleRequestThrow(const server::http::HttpRequest& request,
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
      return ErrorJson("invalid_api_key", "invalid or revoked API key");
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
    return ErrorJson("rate_limit_exceeded", "rate limit exceeded");
  }
  response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rl_max));
  response.SetHeader(std::string{"X-RateLimit-Remaining"},
                     std::to_string(rate_limit_.RemainingWithTier(limit_key, rl_max, rl_window)));

  if (user_token.empty()) {
    const auto session = auth::RequireFullSession(request, oauth_);
    if (!session) {
      return ErrorJson("not_authenticated", "Login with Genius to find more connections.");
    }
    const auto connected = user_provider_tokens_.Get(auth::SessionUserId(*session), "genius");
    user_token = auth::GeniusTokenForSession(*session, connected);
    if (user_token.empty()) {
      response.SetStatus(server::http::HttpStatus::kUnprocessableEntity);
      return ErrorJson("no_genius_token",
                       "Connect a Genius token in Settings to find more connections.");
    }
  }

  const std::string& id_arg = request.GetArg("id");
  if (id_arg.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("bad_request", "'id' query parameter is required");
  }
  std::int64_t seed_id = 0;
  try {
    seed_id = std::stoll(id_arg);
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("bad_request", "'id' must be numeric");
  }

  std::optional<ArtistRef> seed;
  try {
    seed = service_.ResolveById(seed_id, user_token);
  } catch (const GeniusHttpError& e) {
    return GeniusErrorJson(e, response);
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return ErrorJson("genius_error", "could not reach Genius");
  }
  if (!seed) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return ErrorJson("not_found", "artist id not found: " + id_arg);
  }

  std::vector<ProviderEdge> provider_edges;
  try {
    provider_edges = genius_provider_.GetCollaborationEdges(*seed, user_token);
  } catch (const GeniusHttpError& e) {
    return GeniusErrorJson(e, response);
  } catch (const std::exception& ex) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return ErrorJson("genius_error", ex.what());
  }

  std::unordered_map<std::int64_t, NeighbourAgg> aggs;
  std::vector<std::int64_t> order;

  for (const auto& pe : provider_edges) {
    if (pe.to == seed->id) continue;
    auto& agg = aggs[pe.to];
    if (agg.weight == 0) order.push_back(pe.to);
    ++agg.weight;
    if (std::find(agg.roles.begin(), agg.roles.end(), pe.role) == agg.roles.end()) {
      agg.roles.push_back(pe.role);
    }
    const int rank = RoleRank(pe.role);
    if (rank > agg.best_rank) {
      agg.best_rank = rank;
      agg.dominant_role = pe.role;
    }
    agg.source = ToString(pe.source);
  }

  formats::json::ValueBuilder nodes_b(formats::json::Type::kArray);
  formats::json::ValueBuilder edges_b(formats::json::Type::kArray);

  for (const auto neighbour_id : order) {
    const auto& agg = aggs.at(neighbour_id);

    std::optional<ArtistRef> neighbour_ref;
    try {
      neighbour_ref = service_.ResolveById(neighbour_id, user_token);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[GraphDeepenHandler] resolve neighbour " << neighbour_id << ": "
                    << ex.what();
    }
    if (!neighbour_ref) {
      ArtistRef bare;
      bare.id = neighbour_id;
      neighbour_ref = bare;
      LOG_DEBUG() << "[GraphDeepenHandler] neighbour " << neighbour_id
                  << " has no resolvable card — keeping the edge without a name";
    }

    auto nb = dto::ToJson(dto::ToDto(*neighbour_ref));
    nb["weight"] = agg.weight;
    // [SF-WEB-77] Тот же набор ролей на узле, что и в /graph: ответы
    // углубления клиент сливает с уже нарисованным графом, и узел из
    // deepen'а обязан быть той же формы, иначе роли у него «пропадут».
    {
      formats::json::ValueBuilder rb(formats::json::Type::kArray);
      for (const auto& r : agg.roles) rb.PushBack(r);
      nb["roles"] = std::move(rb);
    }
    nb["betweenness"] = 0.0;
    nb["betweenness_normalised"] = 0.0;
    nb["is_seed"] = false;
    nodes_b.PushBack(std::move(nb));

    dto::GraphEdgeDto edge_dto;
    edge_dto.from = seed->id;
    edge_dto.to = neighbour_id;
    edge_dto.weight = agg.weight;
    edge_dto.collaboration_count = agg.weight;
    edge_dto.dominant_role = agg.dominant_role;
    edge_dto.edge_style = std::string{EdgeStyleForRole(agg.dominant_role)};
    edge_dto.source = agg.source;
    edge_dto.collaborations.push_back({"", 0, agg.roles});
    edges_b.PushBack(dto::ToJson(edge_dto));
  }

  formats::json::ValueBuilder out(formats::json::Type::kObject);
  out["type"] = std::string{"graph_deepen"};
  out["seed_id"] = seed->id;
  out["nodes"] = std::move(nodes_b);
  out["edges"] = std::move(edges_b);
  return formats::json::ToString(out.ExtractValue());
}

yaml_config::Schema GraphDeepenHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGraphDeepenHandlerSchema);
}

}  // namespace six_feat
