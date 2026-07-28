#include "internal_handlers.hpp"

#include "schemas/handlers/enrichment/enqueue_handler_schema.hpp"
#include "schemas/handlers/enrichment/internal_status_handler_schema.hpp"
#include "schemas/handlers/enrichment/readiness_handler_schema.hpp"

#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-http/readiness_common.hpp>
#include <stdexcept>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat::enrichment {

using namespace userver;

namespace {

bool SecretMatches(const server::http::HttpRequest& request, const std::string& expected) {
  const std::string& given = request.GetHeader(internal_api::kSecretHeader);
  return internal_api::SecretEquals(given, expected);
}

std::string ErrorJson(const std::string& error) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["error"] = error;
  return formats::json::ToString(b.ExtractValue());
}

bool ParseArtistId(const std::string& raw, std::int64_t& out_id) {
  if (raw.empty()) return false;
  try {
    std::size_t pos = 0;
    out_id = std::stoll(raw, &pos);
    return pos == raw.size();
  } catch (...) {
    return false;
  }
}

}  // namespace

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

  if (!SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return ErrorJson("unauthorized");
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
    return ErrorJson("invalid JSON body");
  }

  if (artist_id == 0 || user_token.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("artist_id and user_token are required");
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

InternalStatusHandler::InternalStatusHandler(const components::ComponentConfig& config,
                                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      store_(context.FindComponent<PersistentStore>()),
      worker_(context.FindComponent<EnrichmentWorker>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string InternalStatusHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                      server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return ErrorJson("unauthorized");
  }

  std::int64_t artist_id = 0;
  if (!ParseArtistId(request.GetArg("id"), artist_id)) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("missing or invalid ?id=<artist_id>");
  }

  const auto state = store_.GetFetchState(artist_id);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["artist_id"] = artist_id;
  b["depth"] = static_cast<int>(state.depth);
  b["song_count"] = state.song_count;
  b["last_fetch_ts"] = state.last_fetch_ts;
  b["enriching"] = worker_.IsPending(artist_id);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema InternalStatusHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kInternalStatusHandlerSchema);
}

ReadinessHandler::ReadinessHandler(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : HttpHandlerBase(config, context), store_(context.FindComponent<PersistentStore>()) {}

std::string ReadinessHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                 server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  const bool db_ok = store_.Ping();

  const std::vector<ReadinessCheck> checks{
      {"database", db_ok, db_ok ? "ok" : "error"},
  };

  return BuildReadinessBody(request, checks);
}

yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kEnrichmentReadinessHandlerSchema);
}

}  // namespace six_feat::enrichment