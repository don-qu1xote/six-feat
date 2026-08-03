#include "track_artists_handler.hpp"

#include "schemas/handlers/yandex-gateway/track_artists_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "common.hpp"

namespace six_feat::yandex_gateway {

using namespace userver;

TrackArtistsHandler::TrackArtistsHandler(const components::ComponentConfig& config,
                                         const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      gateway_(context.FindComponent<YandexMusicGateway>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string TrackArtistsHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                    server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::int64_t track_id = 0;
  std::string lane_raw;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    track_id = body["track_id"].As<std::int64_t>(0);
    lane_raw = body["lane"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  const auto lane = detail::ParseLane(lane_raw);
  if (track_id <= 0 || !lane) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("track_id is required, lane (foreground|background) if given");
  }

  try {
    const auto found = gateway_.FetchTrack(track_id, *lane);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    if (!found) {
      b["found"] = false;
      return formats::json::ToString(b.ExtractValue());
    }
    b["found"] = true;
    b["title"] = found->title;
    formats::json::ValueBuilder arr(formats::json::Type::kArray);
    for (const auto& a : found->artists) arr.PushBack(detail::ArtistJson(a).ExtractValue());
    b["artists"] = std::move(arr);
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleYandexError(resp, e);
  }
}

yaml_config::Schema TrackArtistsHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kTrackArtistsHandlerSchema);
}

}  // namespace six_feat::yandex_gateway
