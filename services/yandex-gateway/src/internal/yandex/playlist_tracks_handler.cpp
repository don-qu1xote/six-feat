#include "playlist_tracks_handler.hpp"

#include "schemas/handlers/yandex-gateway/playlist_tracks_handler_schema.hpp"

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

PlaylistTracksHandler::PlaylistTracksHandler(const components::ComponentConfig& config,
                                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      gateway_(context.FindComponent<YandexMusicGateway>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string PlaylistTracksHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                      server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::string token, user_id;
  std::int64_t playlist_id = 0;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    token = body["token"].As<std::string>("");
    user_id = body["user_id"].As<std::string>("");
    playlist_id = body["playlist_id"].As<std::int64_t>(0);
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  if (token.empty() || user_id.empty() || playlist_id <= 0) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("token, user_id and playlist_id are required");
  }

  try {
    const auto track_ids =
        gateway_.FetchPlaylistTracks(token, user_id, playlist_id, Lane::Foreground);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    formats::json::ValueBuilder arr(formats::json::Type::kArray);
    for (const auto tid : track_ids) arr.PushBack(tid);
    b["track_ids"] = std::move(arr);
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleYandexError(resp, e);
  }
}

yaml_config::Schema PlaylistTracksHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kPlaylistTracksHandlerSchema);
}

}  // namespace six_feat::yandex_gateway
