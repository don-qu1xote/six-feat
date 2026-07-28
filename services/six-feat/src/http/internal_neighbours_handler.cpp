#include "http/internal_neighbours_handler.hpp"

#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/request_id.hpp>

#include <six-feat-domain/domain_types.hpp>

#include "schemas/handlers/six-feat/internal_neighbours_handler_schema.hpp"

#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <utility>

namespace six_feat {

using namespace userver;

namespace {

std::string ErrorJson(const std::string& error) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["error"] = error;
  return formats::json::ToString(b.ExtractValue());
}

bool SecretMatches(const server::http::HttpRequest& request, const std::string& expected) {
  const std::string& given = request.GetHeader(internal_api::kSecretHeader);
  return internal_api::SecretEquals(given, expected);
}

RoleMask RoleMaskFromBits(int bits) {
  if (bits <= 0) return RoleMask{};
  RoleMask mask;
  mask.primary = (bits & 1) != 0;
  mask.producer = (bits & 2) != 0;
  mask.writer = (bits & 4) != 0;
  mask.featured = (bits & 8) != 0;
  return mask;
}

}  // namespace
InternalNeighboursHandler::InternalNeighboursHandler(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      repo_(context.FindComponent<ArtistRepository>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string InternalNeighboursHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                          server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return ErrorJson("unauthorized");
  }

  std::int64_t artist_id = 0;
  int role_mask_bits = 0;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    artist_id = body["artist_id"].As<std::int64_t>(0);
    role_mask_bits = body["role_mask"].As<int>(0);
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("invalid JSON body");
  }

  if (artist_id <= 0) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("artist_id is required");
  }

  const auto mask = RoleMaskFromBits(role_mask_bits);
  const auto neighbours = repo_.Neighbours(artist_id, mask);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  formats::json::ValueBuilder arr(formats::json::Type::kArray);
  for (const auto& edge : neighbours) arr.PushBack(edge.neighbour);
  b["neighbours"] = std::move(arr);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema InternalNeighboursHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kInternalNeighboursHandlerSchema);
}

}  // namespace six_feat