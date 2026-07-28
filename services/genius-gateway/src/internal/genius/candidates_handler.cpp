#include "candidates_handler.hpp"

#include "schemas/handlers/genius-gateway/candidates_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "common.hpp"

namespace six_feat::genius_gateway {

using namespace userver;

CandidatesHandler::CandidatesHandler(const components::ComponentConfig& config,
                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      gateway_(context.FindComponent<GeniusGateway>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string CandidatesHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                  server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::string query, user_token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    query = body["query"].As<std::string>("");
    user_token = body["user_token"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  if (query.empty() || user_token.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("query and user_token are required");
  }

  try {
    const auto candidates = gateway_.ResolveCandidates(query, user_token);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    formats::json::ValueBuilder arr(formats::json::Type::kArray);
    for (const auto& c : candidates) {
      formats::json::ValueBuilder cb(formats::json::Type::kObject);
      cb["id"] = c.id;
      cb["name"] = c.name;
      cb["image"] = c.image;
      cb["url"] = c.url;
      cb["score"] = c.score;
      arr.PushBack(cb.ExtractValue());
    }
    b["candidates"] = std::move(arr);
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleGeniusError(resp, e);
  }
}

yaml_config::Schema CandidatesHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kCandidatesHandlerSchema);
}

}  // namespace six_feat::genius_gateway
