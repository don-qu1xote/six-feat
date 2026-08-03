#include "settings_handler.hpp"

#include "schemas/handlers/six-feat/settings_disconnect_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_enrichment_provider_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_genius_connect_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_status_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_yandex_device_poll_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_yandex_device_start_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_yandex_import_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_yandex_playlists_handler_schema.hpp"

#include <charconv>
#include <chrono>
#include <cstdint>
#include <six-feat-auth-lib/user_identity.hpp>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/resilience.hpp>
#include <six-feat-core/security_headers.hpp>
#include <string>
#include <unordered_map>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <variant>

#include "token_router.hpp"

namespace six_feat {

using namespace userver;

namespace {

constexpr std::int64_t kFarFutureSeconds = 10LL * 365 * 24 * 3600;

std::int64_t NowUnix() {
  return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count());
}

constexpr std::size_t kImportMaxTracks = 20;

bool ParseStrictNumericId(const std::string& param, std::int64_t& out_id) {
  if (param.empty()) return false;
  const char* begin = param.data();
  const char* end = param.data() + param.size();
  auto [ptr, ec] = std::from_chars(begin, end, out_id);
  return ec == std::errc{} && ptr == end;
}

}  // namespace

SettingsStatusHandler::SettingsStatusHandler(const components::ComponentConfig& config,
                                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsStatusHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                      server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const auto user_id = auth::SessionUserId(*session);
  const bool genius_connected = user_provider_tokens_.Get(user_id, "genius").has_value();
  const bool yandex_connected = user_provider_tokens_.Get(user_id, "yandex").has_value();

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  formats::json::ValueBuilder genius(formats::json::Type::kObject);
  genius["connected"] = genius_connected;
  b["genius"] = std::move(genius);
  formats::json::ValueBuilder yandex(formats::json::Type::kObject);
  yandex["connected"] = yandex_connected;
  b["yandex"] = std::move(yandex);
  b["preferred_enrichment_provider"] =
      user_provider_tokens_.GetPreferredEnrichmentProvider(user_id);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsStatusHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kSettingsStatusHandlerSchema);
}

SettingsGeniusConnectHandler::SettingsGeniusConnectHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsGeniusConnectHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  std::string token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    token = body["token"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "body must be JSON with a string token");
  }
  if (token.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request, server::http::HttpStatus::kBadRequest, "token is required");
  }

  user_provider_tokens_.Connect(
      auth::SessionUserId(*session), "genius", token, NowUnix() + kFarFutureSeconds);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["provider"] = std::string{"genius"};
  b["connected"] = true;
  response.SetStatus(server::http::HttpStatus::kOk);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsGeniusConnectHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsGeniusConnectHandlerSchema);
}

SettingsDisconnectHandler::SettingsDisconnectHandler(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsDisconnectHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                          server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const std::string& provider = request.GetArg("provider");
  if (provider != "genius" && provider != "yandex") {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "?provider= must be 'genius' or 'yandex'");
  }

  const bool disconnected =
      user_provider_tokens_.Disconnect(auth::SessionUserId(*session), provider);
  if (!disconnected) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return BuildProblemJson(request, server::http::HttpStatus::kNotFound, "not_connected");
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["provider"] = provider;
  b["connected"] = false;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsDisconnectHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsDisconnectHandlerSchema);
}

SettingsEnrichmentProviderHandler::SettingsEnrichmentProviderHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsEnrichmentProviderHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  std::string provider;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    provider = body["provider"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "body must be JSON with a string provider");
  }
  if (provider != "yandex" && provider != "genius") {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "provider must be 'yandex' or 'genius'");
  }

  const auto user_id = auth::SessionUserId(*session);
  user_provider_tokens_.SetPreferredEnrichmentProvider(user_id, provider);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["preferred_enrichment_provider"] = provider;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsEnrichmentProviderHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsEnrichmentProviderHandlerSchema);
}

SettingsYandexDeviceStartHandler::SettingsYandexDeviceStartHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      yandex_client_(context.FindComponent<YandexGatewayClient>()) {}

std::string SettingsYandexDeviceStartHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!auth::RequireFullSession(request, oauth_)) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  try {
    const auto start = yandex_client_.StartDeviceFlow();
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["device_code"] = start.device_code;
    b["user_code"] = start.user_code;
    b["verification_url"] = start.verification_url;
    b["interval"] = start.interval_seconds;
    b["expires_in"] = start.expires_in_seconds;
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError&) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadGateway, "could not reach Yandex");
  }
}

yaml_config::Schema SettingsYandexDeviceStartHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsYandexDeviceStartHandlerSchema);
}

SettingsYandexDevicePollHandler::SettingsYandexDevicePollHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      yandex_client_(context.FindComponent<YandexGatewayClient>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsYandexDevicePollHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  std::string device_code;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    device_code = body["device_code"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "body must be JSON with a string device_code");
  }
  if (device_code.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "device_code is required");
  }

  YandexDeviceFlowPollResult result;
  try {
    result = yandex_client_.PollDeviceFlow(device_code);
  } catch (const GeniusHttpError&) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadGateway, "could not reach Yandex");
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  switch (result.status) {
    case YandexDeviceFlowStatus::kSuccess: {
      const std::int64_t expires_at =
          NowUnix() +
          (result.expires_in_seconds > 0 ? result.expires_in_seconds : kFarFutureSeconds);
      user_provider_tokens_.Connect(
          auth::SessionUserId(*session), "yandex", result.access_token, expires_at);
      b["status"] = std::string{"connected"};
      break;
    }
    case YandexDeviceFlowStatus::kPending:
      b["status"] = std::string{"pending"};
      break;
    case YandexDeviceFlowStatus::kDenied:
      b["status"] = std::string{"denied"};
      break;
    case YandexDeviceFlowStatus::kExpired:
      b["status"] = std::string{"expired"};
      break;
  }
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsYandexDevicePollHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsYandexDevicePollHandlerSchema);
}

SettingsYandexPlaylistsHandler::SettingsYandexPlaylistsHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      yandex_client_(context.FindComponent<YandexGatewayClient>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsYandexPlaylistsHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const auto personal_token = user_provider_tokens_.Get(auth::SessionUserId(*session), "yandex");
  if (!personal_token) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kNotFound,
                            "no personal Yandex account connected — connect one in Settings first");
  }

  std::optional<std::string> user_id;
  std::vector<YandexPlaylistSummary> playlists;
  std::vector<std::int64_t> liked_track_ids;
  try {
    user_id = yandex_client_.FetchAccountUserId(*personal_token);
    if (user_id) {
      playlists = yandex_client_.FetchPlaylists(*personal_token, *user_id);
      // [SF-WEB-74] Real count instead of a hardcoded 0 — no cheap
      // count-only endpoint exists yet, so this is the same fan-out the
      // import flow already pays for the likes collection.
      liked_track_ids = yandex_client_.FetchLikedTracks(*personal_token, *user_id);
    }
  } catch (const GeniusHttpError&) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadGateway, "could not reach Yandex");
  }
  if (!user_id) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadGateway,
                            "the connected Yandex token is no longer valid — reconnect it");
  }

  formats::json::ValueBuilder out(formats::json::Type::kObject);
  out["type"] = std::string{"yandex_playlists"};
  formats::json::ValueBuilder arr(formats::json::Type::kArray);
  {
    formats::json::ValueBuilder likes(formats::json::Type::kObject);
    likes["id"] = std::string{"likes"};
    likes["kind"] = std::string{"likes"};
    likes["title"] = std::string{"Liked tracks"};
    likes["track_count"] = static_cast<int>(liked_track_ids.size());
    arr.PushBack(std::move(likes));
  }
  for (const auto& p : playlists) {
    formats::json::ValueBuilder pb(formats::json::Type::kObject);
    pb["id"] = std::to_string(p.yandex_id);
    pb["kind"] = std::string{"playlist"};
    pb["title"] = p.title;
    pb["track_count"] = p.track_count;
    if (!p.cover_url.empty()) pb["cover_url"] = p.cover_url;
    arr.PushBack(std::move(pb));
  }
  out["playlists"] = std::move(arr);
  return formats::json::ToString(out.ExtractValue());
}

yaml_config::Schema SettingsYandexPlaylistsHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsYandexPlaylistsHandlerSchema);
}

SettingsYandexImportHandler::SettingsYandexImportHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      yandex_client_(context.FindComponent<YandexGatewayClient>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()),
      service_(context.FindComponent<CollabService>()) {}

std::string SettingsYandexImportHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const auto personal_token = user_provider_tokens_.Get(auth::SessionUserId(*session), "yandex");
  if (!personal_token) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kNotFound,
                            "no personal Yandex account connected — connect one in Settings first");
  }

  const std::string& playlist_arg = request.GetArg("playlist");
  if (playlist_arg.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "'playlist' query parameter is required");
  }
  const bool is_likes = playlist_arg == "likes";
  std::int64_t playlist_id = 0;
  if (!is_likes && !ParseStrictNumericId(playlist_arg, playlist_id)) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "'playlist' must be 'likes' or a numeric id");
  }

  std::optional<std::string> user_id;
  std::vector<std::int64_t> track_ids;
  try {
    user_id = yandex_client_.FetchAccountUserId(*personal_token);
    if (user_id) {
      track_ids = is_likes
                      ? yandex_client_.FetchLikedTracks(*personal_token, *user_id)
                      : yandex_client_.FetchPlaylistTracks(*personal_token, *user_id, playlist_id);
    }
  } catch (const GeniusHttpError&) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadGateway, "could not reach Yandex");
  }
  if (!user_id) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadGateway,
                            "the connected Yandex token is no longer valid — reconnect it");
  }
  // [SF-WEB-74] Truncation used to be silent — capture the pre-truncation
  // count so the client can honestly show "first N of M tracks scanned"
  // instead of a resolved-artist count that looked complete either way.
  const std::size_t total_track_count = track_ids.size();
  const bool truncated = total_track_count > kImportMaxTracks;
  if (truncated) track_ids.resize(kImportMaxTracks);

  std::unordered_map<std::int64_t, std::string> yandex_artists;
  std::vector<std::int64_t> yandex_artist_order;
  for (const auto track_id : track_ids) {
    std::optional<std::vector<YandexArtistRef>> artists;
    try {
      artists = yandex_client_.FetchTrackArtists(track_id);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[SettingsYandexImportHandler] track " << track_id << ": " << ex.what();
      continue;
    }
    if (!artists) continue;
    for (const auto& a : *artists) {
      if (!a.yandex_id || a.name.empty()) continue;
      if (yandex_artists.emplace(a.yandex_id, a.name).second) {
        yandex_artist_order.push_back(a.yandex_id);
      }
    }
  }

  const auto connected_genius = user_provider_tokens_.Get(auth::SessionUserId(*session), "genius");
  const std::string genius_token = auth::GeniusTokenForSession(*session, connected_genius);
  if (genius_token.empty()) {
    response.SetStatus(server::http::HttpStatus::kUnprocessableEntity);
    return BuildProblemJson(
        request,
        server::http::HttpStatus::kUnprocessableEntity,
        "no Genius token available for this session — connect a Genius token in settings "
        "before importing");
  }

  formats::json::ValueBuilder artists_b(formats::json::Type::kArray);
  int resolved_count = 0;
  for (const auto yid : yandex_artist_order) {
    const std::string& yandex_name = yandex_artists.at(yid);

    formats::json::ValueBuilder ab(formats::json::Type::kObject);
    ab["yandex_name"] = yandex_name;

    std::variant<ArtistRef, AmbiguousResult> resolved;
    try {
      resolved = service_.ResolveByName(yandex_name, genius_token);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[SettingsYandexImportHandler] resolve '" << yandex_name
                    << "': " << ex.what();
      ab["resolved"] = false;
      artists_b.PushBack(std::move(ab));
      continue;
    }

    if (std::holds_alternative<ArtistRef>(resolved)) {
      const auto& ref = std::get<ArtistRef>(resolved);
      ab["resolved"] = true;
      ab["id"] = ref.id;
      ab["name"] = ref.name;
      if (!ref.image.empty()) ab["image"] = ref.image;
      if (!ref.url.empty()) ab["url"] = ref.url;
      ++resolved_count;
    } else {
      ab["resolved"] = false;
    }
    artists_b.PushBack(std::move(ab));
  }

  formats::json::ValueBuilder out(formats::json::Type::kObject);
  out["type"] = std::string{"yandex_import"};
  out["source"] = is_likes ? std::string{"likes"} : std::string{"playlist"};
  out["playlist_id"] = playlist_arg;
  out["artists"] = std::move(artists_b);
  out["resolved_count"] = resolved_count;
  out["total_count"] = static_cast<int>(yandex_artist_order.size());
  out["truncated"] = truncated;
  out["total_track_count"] = static_cast<std::int64_t>(total_track_count);
  out["scanned_track_count"] = static_cast<std::int64_t>(track_ids.size());
  return formats::json::ToString(out.ExtractValue());
}

yaml_config::Schema SettingsYandexImportHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsYandexImportHandlerSchema);
}

}  // namespace six_feat
