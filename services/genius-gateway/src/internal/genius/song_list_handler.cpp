#include "song_list_handler.hpp"

#include "schemas/handlers/genius-gateway/song_list_handler_schema.hpp"

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

SongListHandler::SongListHandler(const components::ComponentConfig& config,
                                 const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      gateway_(context.FindComponent<GeniusGateway>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string SongListHandler::HandleRequestThrow(const server::http::HttpRequest& request,
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
  std::string lane_raw, user_token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    artist_id = body["artist_id"].As<std::int64_t>(0);
    limit = body["limit"].As<int>(0);
    lane_raw = body["lane"].As<std::string>("");
    user_token = body["user_token"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  const auto lane = detail::ParseLane(lane_raw);
  if (artist_id <= 0 || !lane || user_token.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("artist_id, lane (foreground|background) and user_token are required");
  }

  if (limit <= 0) {
    limit = (*lane == Lane::kForeground) ? gateway_.SongsLimitFg() : gateway_.SongsLimitBg();
  }

  try {
    const auto ids = gateway_.FetchSongList(artist_id, limit, *lane, user_token);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    formats::json::ValueBuilder ids_arr(formats::json::Type::kArray);
    for (const auto sid : ids) ids_arr.PushBack(sid);
    b["song_ids"] = std::move(ids_arr);
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleGeniusError(resp, e);
  }
}

yaml_config::Schema SongListHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kSongListHandlerSchema);
}

}  // namespace six_feat::genius_gateway
