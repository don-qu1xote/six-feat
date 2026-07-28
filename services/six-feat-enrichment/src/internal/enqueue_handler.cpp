#include "enqueue_handler.hpp"

#include "schemas/handlers/enrichment/enqueue_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "common.hpp"

namespace six_feat::enrichment {

using namespace userver;

EnqueueHandler::EnqueueHandler(const components::ComponentConfig& config,
                               const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      worker_(context.FindComponent<EnrichmentWorker>()),
      repo_(context.FindComponent<ArtistRepository>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string EnqueueHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                               server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::int64_t artist_id = 0;
  std::string user_token;
  ArtistRef ref;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    artist_id = body["artist_id"].As<std::int64_t>(0);
    user_token = body["user_token"].As<std::string>("");
    ref.id = artist_id;
    ref.name = body["name"].As<std::string>("");
    ref.image = body["image"].As<std::string>("");
    ref.url = body["url"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  if (artist_id == 0 || user_token.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("artist_id and user_token are required");
  }

  if (ref.name.empty()) {
    if (auto known = repo_.Lookup(ref.id)) ref = std::move(*known);
  }

  const bool enqueued = worker_.EnqueueIfNeeded(ref, user_token);

  resp.SetStatus(server::http::HttpStatus::kAccepted);
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["artist_id"] = ref.id;
  b["enqueued"] = enqueued;
  b["status"] = enqueued ? std::string{"enqueued"} : std::string{"skipped"};
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema EnqueueHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kEnqueueHandlerSchema);
}

}  // namespace six_feat::enrichment
