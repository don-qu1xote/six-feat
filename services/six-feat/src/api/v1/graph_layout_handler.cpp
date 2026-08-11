#include "graph_layout_handler.hpp"

#include "auth/api_key_auth.hpp"

#include "schemas/handlers/six-feat/graph_layout_handler_schema.hpp"

#include <cstdint>
#include <exception>
#include <six-feat-auth-lib/user_identity.hpp>
#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-layout/layout.hpp>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <utility>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

constexpr std::size_t kMaxNodes = 5000;
constexpr std::size_t kMaxEdges = 20000;

constexpr double kMinNodeRadius = 1.0;
constexpr double kMaxNodeRadius = 400.0;
constexpr double kMinNodeGap = 0.0;
constexpr double kMaxNodeGap = 2000.0;

std::string ErrorLayout(const std::string& message) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"graph_layout"};
  b["error"] = message;
  b["request_id"] = CurrentRequestId();
  return formats::json::ToString(b.ExtractValue());
}

std::string RateLimitKey(const server::http::HttpRequest& request, const auth::OAuthConfig& oauth) {
  std::string token = auth::ExtractToken(request, oauth.SessionKey());
  if (!token.empty()) return token;
  return request.GetRemoteAddress().PrimaryAddressString();
}

struct ParseError {
  std::string message;
};

layout::LayoutRequest ParseRequest(const formats::json::Value& body) {
  layout::LayoutRequest out;

  if (!body.IsObject()) throw ParseError{"body must be a JSON object"};
  if (!body.HasMember("seed_id")) throw ParseError{"'seed_id' is required"};
  out.seed_id = body["seed_id"].As<std::int64_t>();

  const auto nodes = body["nodes"];
  if (!nodes.IsArray()) throw ParseError{"'nodes' must be an array of artist ids"};
  if (nodes.GetSize() > kMaxNodes) throw ParseError{"too many nodes"};
  out.nodes.reserve(nodes.GetSize());
  for (const auto& n : nodes) out.nodes.push_back(n.As<std::int64_t>());

  const auto edges = body["edges"];
  if (!edges.IsArray()) throw ParseError{"'edges' must be an array of [from, to] pairs"};
  if (edges.GetSize() > kMaxEdges) throw ParseError{"too many edges"};
  out.edges.reserve(edges.GetSize());
  for (const auto& e : edges) {
    if (!e.IsArray() || e.GetSize() != 2) throw ParseError{"every edge must be a [from, to] pair"};
    out.edges.emplace_back(e[0].As<std::int64_t>(), e[1].As<std::int64_t>());
  }

  const auto expanded = body["expanded"];
  if (!expanded.IsArray()) throw ParseError{"'expanded' must be an array of artist ids"};
  if (expanded.GetSize() > kMaxNodes) throw ParseError{"too many expanded nodes"};
  out.expanded.reserve(expanded.GetSize());
  for (const auto& id : expanded) out.expanded.push_back(id.As<std::int64_t>());

  if (body.HasMember("expand_parent")) {
    const auto parents = body["expand_parent"];
    if (!parents.IsObject()) throw ParseError{"'expand_parent' must be an object"};
    for (auto it = parents.begin(); it != parents.end(); ++it) {
      out.expand_parent[std::stoll(it.GetName())] = it->As<std::int64_t>();
    }
  }

  if (body.HasMember("pinned")) {
    const auto pinned = body["pinned"];
    if (!pinned.IsObject()) throw ParseError{"'pinned' must be an object of id -> {x, y}"};
    for (auto it = pinned.begin(); it != pinned.end(); ++it) {
      const auto& p = *it;
      if (!p.IsObject()) throw ParseError{"every pinned position must be an {x, y} object"};
      out.pinned[std::stoll(it.GetName())] =
          layout::Point{p["x"].As<double>(), p["y"].As<double>()};
    }
  }

  if (body.HasMember("node_radius")) out.params.node_radius = body["node_radius"].As<double>();
  if (body.HasMember("node_gap")) out.params.node_gap = body["node_gap"].As<double>();
  if (!(out.params.node_radius >= kMinNodeRadius && out.params.node_radius <= kMaxNodeRadius)) {
    throw ParseError{"'node_radius' out of range"};
  }
  if (!(out.params.node_gap >= kMinNodeGap && out.params.node_gap <= kMaxNodeGap)) {
    throw ParseError{"'node_gap' out of range"};
  }

  return out;
}

}  // namespace

GraphLayoutHandler::GraphLayoutHandler(const components::ComponentConfig& config,
                                       const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      api_key_store_(context.FindComponent<auth::ApiKeyStore>()),
      rate_limit_(
          "graph-layout", 120, 1, context.FindComponent<RateLimitStoreComponent>().MakeStore()) {}

std::string GraphLayoutHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                   server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  std::string limit_key;
  int rl_max = rate_limit_.Limit();
  std::chrono::seconds rl_window = rate_limit_.Window();

  const auto api_key_check = CheckApiKeyHeader(request, api_key_store_);
  if (api_key_check.provided) {
    if (!api_key_check.identity) {
      response.SetStatus(server::http::HttpStatus::kUnauthorized);
      return ErrorLayout("invalid_api_key");
    }
    const auto& identity = *api_key_check.identity;
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
    return ErrorLayout("rate limit exceeded");
  }
  response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rl_max));
  response.SetHeader(std::string{"X-RateLimit-Remaining"},
                     std::to_string(rate_limit_.RemainingWithTier(limit_key, rl_max, rl_window)));

  if (!api_key_check.provided && !auth::RequireFullSession(request, oauth_)) {
    return ErrorLayout("not_authenticated");
  }

  layout::LayoutRequest layout_request;
  try {
    layout_request = ParseRequest(formats::json::FromString(request.RequestBody()));
  } catch (const ParseError& e) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorLayout(e.message);
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorLayout("body must be JSON describing the graph to lay out");
  }

  const auto result = layout::PlaceExpandedNodes(layout_request);

  formats::json::ValueBuilder out(formats::json::Type::kObject);
  out["type"] = std::string{"graph_layout"};
  formats::json::ValueBuilder positions(formats::json::Type::kArray);
  for (const auto id : result.order) {
    const auto& p = result.positions.at(id);
    formats::json::ValueBuilder item(formats::json::Type::kObject);
    item["id"] = id;
    item["x"] = p.x;
    item["y"] = p.y;
    positions.PushBack(std::move(item));
  }
  out["positions"] = std::move(positions);

  return formats::json::ToString(out.ExtractValue());
}

yaml_config::Schema GraphLayoutHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGraphLayoutHandlerSchema);
}

}  // namespace six_feat
