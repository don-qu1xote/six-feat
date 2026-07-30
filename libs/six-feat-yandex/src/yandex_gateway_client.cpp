#include "schemas/components/yandex_gateway_client_schema.hpp"

#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/internal_http.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/resilience.hpp>
#include <six-feat-yandex/yandex_gateway_client.hpp>
#include <stdexcept>
#include <string>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("yandex-gateway-client: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

}  // namespace

YandexGatewayClient::YandexGatewayClient(const components::ComponentConfig& config,
                                         const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      base_url_(config["yandex-gateway-base-url"].As<std::string>()),
      shared_secret_(internal_api::SharedSecretFromEnv()),
      timeout_(std::chrono::milliseconds{
          RequirePositive("timeout-ms", config["timeout-ms"].As<int>(5000))}),
      tracks_limit_(RequirePositive("tracks-limit", config["tracks-limit"].As<int>(20))) {}

yaml_config::Schema YandexGatewayClient::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kYandexGatewayClientComponentSchema);
}

formats::json::Value YandexGatewayClient::PostInternal(const std::string& path,
                                                       formats::json::ValueBuilder& body) const {
  const std::string request_id = CurrentRequestId();
  try {
    const auto resp = internal_http::Post(http_client_,
                                          base_url_ + path,
                                          shared_secret_,
                                          formats::json::ToString(body.ExtractValue()),
                                          timeout_,
                                          request_id);

    const int status = resp.status_code;
    if (status < 200 || status >= 300) {
      throw GeniusHttpError{
          status, "yandex-gateway-client: HTTP " + std::to_string(status) + " from " + path};
    }
    return formats::json::FromString(resp.body);
  } catch (const GeniusHttpError&) {
    throw;
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[YGWClient] request_id=" << request_id << " " << path
                  << " failed: " << ex.what();
    throw GeniusHttpError{502, "yandex-gateway-client: request failed: " + std::string(ex.what())};
  }
}

std::vector<YandexArtistRef> YandexGatewayClient::SearchArtist(const std::string& query) const {
  formats::json::ValueBuilder body(formats::json::Type::kObject);
  body["query"] = query;

  const auto json = PostInternal("/internal/yandex/search-artist", body);
  const auto& arr = json["candidates"];

  std::vector<YandexArtistRef> out;
  if (arr.IsArray()) {
    out.reserve(arr.GetSize());
    for (const auto& c : arr) {
      YandexArtistRef ref;
      ref.yandex_id = c["id"].As<std::int64_t>(0);
      ref.name = c["name"].As<std::string>("");
      ref.image = c["image"].As<std::string>("");
      if (ref.yandex_id) out.push_back(std::move(ref));
    }
  }
  return out;
}

std::optional<std::vector<YandexArtistRef>> YandexGatewayClient::FetchTrackArtists(
    std::int64_t track_id) const {
  formats::json::ValueBuilder body(formats::json::Type::kObject);
  body["track_id"] = track_id;

  const auto json = PostInternal("/internal/yandex/track-artists", body);
  if (!json["found"].As<bool>(false)) return std::nullopt;

  const auto& arr = json["artists"];
  std::vector<YandexArtistRef> out;
  if (arr.IsArray()) {
    out.reserve(arr.GetSize());
    for (const auto& a : arr) {
      YandexArtistRef ref;
      ref.yandex_id = a["id"].As<std::int64_t>(0);
      ref.name = a["name"].As<std::string>("");
      ref.image = a["image"].As<std::string>("");
      if (ref.yandex_id) out.push_back(std::move(ref));
    }
  }
  return out;
}

std::vector<std::int64_t> YandexGatewayClient::FetchArtistTracks(
    std::int64_t yandex_artist_id) const {
  formats::json::ValueBuilder body(formats::json::Type::kObject);
  body["artist_id"] = yandex_artist_id;
  body["limit"] = tracks_limit_;

  const auto json = PostInternal("/internal/yandex/artist-tracks", body);
  const auto& arr = json["track_ids"];

  std::vector<std::int64_t> out;
  if (arr.IsArray()) {
    out.reserve(arr.GetSize());
    for (const auto& v : arr) {
      const auto tid = v.As<std::int64_t>(0);
      if (tid) out.push_back(tid);
    }
  }
  return out;
}

YandexDeviceFlowStart YandexGatewayClient::StartDeviceFlow() const {
  formats::json::ValueBuilder body(formats::json::Type::kObject);
  const auto json = PostInternal("/internal/yandex/device/start", body);

  YandexDeviceFlowStart out;
  out.device_code = json["device_code"].As<std::string>("");
  out.user_code = json["user_code"].As<std::string>("");
  out.verification_url = json["verification_url"].As<std::string>("");
  out.interval_seconds = json["interval"].As<int>(5);
  out.expires_in_seconds = json["expires_in"].As<int>(600);
  return out;
}

YandexDeviceFlowPollResult YandexGatewayClient::PollDeviceFlow(
    const std::string& device_code) const {
  formats::json::ValueBuilder body(formats::json::Type::kObject);
  body["device_code"] = device_code;
  const auto json = PostInternal("/internal/yandex/device/poll", body);

  YandexDeviceFlowPollResult out;
  const auto status = json["status"].As<std::string>("pending");
  if (status == "success") {
    out.status = YandexDeviceFlowStatus::kSuccess;
    out.access_token = json["access_token"].As<std::string>("");
    out.expires_in_seconds = json["expires_in"].As<int>(0);
  } else if (status == "denied") {
    out.status = YandexDeviceFlowStatus::kDenied;
  } else if (status == "expired") {
    out.status = YandexDeviceFlowStatus::kExpired;
  } else {
    out.status = YandexDeviceFlowStatus::kPending;
  }
  return out;
}

}  // namespace six_feat
