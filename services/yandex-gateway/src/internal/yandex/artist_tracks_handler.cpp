#include "artist_tracks_handler.hpp"

#include "schemas/handlers/yandex-gateway/artist_tracks_handler_schema.hpp"

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

ArtistTracksHandler::ArtistTracksHandler(const components::ComponentConfig& config,
                                         const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      gateway_(context.FindComponent<YandexMusicGateway>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string ArtistTracksHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                    server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::int64_t artist_id = 0;
  int limit = 0;
  std::string lane_raw;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    artist_id = body["artist_id"].As<std::int64_t>(0);
    limit = body["limit"].As<int>(0);
    lane_raw = body["lane"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  const auto lane = detail::ParseLane(lane_raw);
  if (artist_id <= 0 || !lane) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("artist_id is required, lane (foreground|background) if given");
  }
  if (limit <= 0) limit = 20;

  try {
    const auto track_ids = gateway_.FetchArtistTracks(artist_id, limit, *lane);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    formats::json::ValueBuilder arr(formats::json::Type::kArray);
    for (const auto tid : track_ids) arr.PushBack(tid);
    b["track_ids"] = std::move(arr);
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleYandexError(resp, e);
  }
}

yaml_config::Schema ArtistTracksHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kArtistTracksHandlerSchema);
}

}  // namespace six_feat::yandex_gateway
