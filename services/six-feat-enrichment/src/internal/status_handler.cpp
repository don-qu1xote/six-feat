#include "status_handler.hpp"

#include "schemas/handlers/enrichment/internal_status_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <stdexcept>
#include <string>
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

namespace {

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

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::int64_t artist_id = 0;
  if (!ParseArtistId(request.GetArg("id"), artist_id)) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("missing or invalid ?id=<artist_id>");
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

}  // namespace six_feat::enrichment
