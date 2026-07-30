
#include "schemas/components/yandex_music_gateway_schema.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <six-feat-core/request_id.hpp>
#include <six-feat-yandex/yandex_music_gateway.hpp>
#include <stdexcept>
#include <string>
#include <userver/clients/http/client.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/components/statistics_storage.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/cancel.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/statistics/writer.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("yandex-music-gateway: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

double RequirePositive(std::string_view param, double value) {
  if (!(value > 0.0)) {
    throw std::runtime_error("yandex-music-gateway: " + std::string(param) +
                             " must be a positive number, got " + std::to_string(value));
  }
  return value;
}

std::string ServiceTokenFromEnv() {
  const char* value = std::getenv("YANDEX_SERVICE_TOKEN");
  if (!value || !*value) {
    throw std::runtime_error(
        "YANDEX_SERVICE_TOKEN env var is required — a single Yandex Music "
        "OAuth token for the whole deployment (NOT per-user), see "
        "docs/DEVELOPMENT.md");
  }
  return std::string(value);
}

std::string UrlEncode(std::string_view value) {
  static constexpr const char* kHex = "0123456789ABCDEF";
  std::string out;
  out.reserve(value.size() * 3);
  for (unsigned char c : value) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~')
      out.push_back(static_cast<char>(c));
    else {
      out.push_back('%');
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0x0F]);
    }
  }
  return out;
}

ArtistRef ParseYandexArtist(const formats::json::Value& obj) {
  ArtistRef ref;
  ref.id = obj["id"].As<std::int64_t>(0);
  ref.name = obj["name"].As<std::string>("");
  ref.image = obj["cover"]["uri"].As<std::string>("");
  return ref;
}

}  // namespace

YandexMusicGateway::YandexMusicGateway(const components::ComponentConfig& config,
                                       const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      yandex_base_url_(config["yandex-base-url"].As<std::string>("https://api.music.yandex.net")),
      service_token_(ServiceTokenFromEnv()),
      backoff_max_attempts_(
          RequirePositive("backoff-max-attempts", config["backoff-max-attempts"].As<int>(4))),
      backoff_base_ms_(std::chrono::milliseconds{
          RequirePositive("backoff-base-ms", config["backoff-base-ms"].As<int>(200))}),
      backoff_cap_ms_(std::chrono::milliseconds{
          RequirePositive("backoff-cap-ms", config["backoff-cap-ms"].As<int>(10000))}),
      pipeline_(LaneConfig{RequirePositive("lane-fg-tokens-per-sec",
                                           config["lane-fg-tokens-per-sec"].As<double>(5.0)),
                           RequirePositive("lane-fg-burst", config["lane-fg-burst"].As<int>(5)),
                           RequirePositive("lane-fg-max-concurrent",
                                           config["lane-fg-max-concurrent"].As<int>(5))},
                LaneConfig{RequirePositive("lane-bg-tokens-per-sec",
                                           config["lane-bg-tokens-per-sec"].As<double>(2.0)),
                           RequirePositive("lane-bg-burst", config["lane-bg-burst"].As<int>(2)),
                           RequirePositive("lane-bg-max-concurrent",
                                           config["lane-bg-max-concurrent"].As<int>(1))},
                RequirePositive("cb-failure-threshold", config["cb-failure-threshold"].As<int>(5)),
                std::chrono::seconds{
                    RequirePositive("cb-open-seconds", config["cb-open-seconds"].As<int>(30))}) {
  auto& storage = context.FindComponent<components::StatisticsStorage>().GetStorage();
  statistics_holder_ = storage.RegisterWriter(
      "yandex-music-gateway",
      [this](utils::statistics::Writer& writer) { ExtendStatistics(writer); });
}

YandexMusicGateway::~YandexMusicGateway() {
  statistics_holder_.Unregister();
}

void YandexMusicGateway::ExtendStatistics(utils::statistics::Writer& writer) const {
  const auto state = pipeline_.CbState();
  writer["circuit_breaker"]["state"] = static_cast<int>(state);
  writer["circuit_breaker"]["closed"] = state == CircuitBreaker::State::Closed ? 1 : 0;
  writer["circuit_breaker"]["open"] = state == CircuitBreaker::State::Open ? 1 : 0;
  writer["circuit_breaker"]["half_open"] = state == CircuitBreaker::State::HalfOpen ? 1 : 0;

  writer["lane"]["foreground"]["tokens_available"] = pipeline_.FgTokensAvailable();
  writer["lane"]["foreground"]["slots_available"] = pipeline_.FgSlotsAvailable();
  writer["lane"]["background"]["tokens_available"] = pipeline_.BgTokensAvailable();
  writer["lane"]["background"]["slots_available"] = pipeline_.BgSlotsAvailable();
}

std::string YandexMusicGateway::YandexGetWithToken(const std::string& url,
                                                   Lane lane,
                                                   const std::string& auth_token) const {
  const std::string auth = "OAuth " + auth_token;
  const std::string& request_id = CurrentRequestId();
  int attempt = 0;
  int last_5xx_status = 502;

  while (true) {
    auto guard = pipeline_.Acquire(lane);
    bool failure_already_recorded_for_this_attempt = false;

    try {
      const auto resp = http_client_.CreateRequest()
                            .get(url)
                            .headers({{"Authorization", auth}, {"X-Request-Id", request_id}})
                            .timeout(std::chrono::seconds{5})
                            .retry(0)
                            .perform();
      const int status = resp->status_code();

      pipeline_.OnResponse(guard, status, -1, 0);

      if (status >= 200 && status < 300) return resp->body();

      if (status == 401)
        throw GeniusHttpError{401, "yandex-music-gateway: token invalid or expired"};

      if (status >= 400 && status < 500)
        throw GeniusHttpError{status, "HTTP " + std::to_string(status)};

      last_5xx_status = status;
      failure_already_recorded_for_this_attempt = true;
      LOG_WARNING() << "[YMGW] request_id=" << request_id << " HTTP " << status
                    << " attempt=" << attempt << " url=" << url;

    } catch (const GeniusHttpError&) {
      throw;
    } catch (const std::exception& ex) {
      if (engine::current_task::ShouldCancel()) {
        LOG_DEBUG() << "[YMGW] request_id=" << request_id
                    << " request cancelled (client gone / deadline) for " << url;
        throw GeniusHttpError{499, "client request cancelled"};
      }

      if (std::string(ex.what()).find("deadline propagation") != std::string::npos) {
        LOG_WARNING() << "[YMGW] request_id=" << request_id << " deadline budget exhausted for "
                      << url;
        throw GeniusHttpError{504, "deadline exhausted for this request"};
      }
      pipeline_.OnNetworkError();
      failure_already_recorded_for_this_attempt = true;
      LOG_WARNING() << "[YMGW] request_id=" << request_id << " network error attempt=" << attempt
                    << ": " << ex.what();
    }

    ++attempt;
    if (attempt >= backoff_max_attempts_) {
      if (!failure_already_recorded_for_this_attempt) {
        pipeline_.OnNetworkError();
      }
      throw GeniusHttpError{last_5xx_status, "exhausted retries: " + url};
    }
    const auto backoff = ExponentialBackoff(attempt, backoff_base_ms_, backoff_cap_ms_);
    LOG_INFO() << "[YMGW] request_id=" << request_id << " retrying attempt=" << attempt << " in "
               << backoff.count() << "ms";
    engine::InterruptibleSleepFor(backoff);
  }
}

std::string YandexMusicGateway::YandexGet(const std::string& url, Lane lane) const {
  return YandexGetWithToken(url, lane, service_token_);
}

std::optional<std::vector<ArtistRef>> YandexMusicGateway::FetchTrackArtists(std::int64_t track_id,
                                                                            Lane lane) const {
  const std::string url = yandex_base_url_ + "/tracks/" + std::to_string(track_id);
  const auto json = formats::json::FromString(YandexGet(url, lane));
  const auto& result = json["result"];
  if (!result.IsArray() || result.GetSize() == 0) return std::nullopt;

  const auto& track = result[0];
  const auto& artists_arr = track["artists"];

  std::vector<ArtistRef> out;
  if (artists_arr.IsArray()) {
    out.reserve(artists_arr.GetSize());
    for (const auto& a : artists_arr) {
      auto ref = ParseYandexArtist(a);
      if (ref.id) out.push_back(std::move(ref));
    }
  }
  return out;
}

std::vector<Candidate> YandexMusicGateway::SearchArtist(const std::string& query, Lane lane) const {
  const std::string url = yandex_base_url_ + "/search?type=artist&text=" + UrlEncode(query);
  const auto json = formats::json::FromString(YandexGet(url, lane));
  const auto& results = json["result"]["artists"]["results"];

  std::vector<Candidate> out;
  if (results.IsArray()) {
    out.reserve(results.GetSize());
    for (const auto& a : results) {
      const auto ref = ParseYandexArtist(a);
      if (!ref.id) continue;
      Candidate c;
      c.id = ref.id;
      c.name = ref.name;
      c.image = ref.image;
      c.score = 1.0;
      out.push_back(std::move(c));
    }
  }
  return out;
}

std::vector<YandexPlaylistRef> YandexMusicGateway::FetchPlaylists(const std::string& personal_token,
                                                                  const std::string& user_id,
                                                                  Lane lane) const {
  const std::string url = yandex_base_url_ + "/users/" + user_id + "/playlists/list";
  const auto json = formats::json::FromString(YandexGetWithToken(url, lane, personal_token));
  const auto& result = json["result"];

  std::vector<YandexPlaylistRef> out;
  if (result.IsArray()) {
    out.reserve(result.GetSize());
    for (const auto& p : result) {
      YandexPlaylistRef ref;
      ref.id = p["id"].As<std::int64_t>(0);
      ref.title = p["title"].As<std::string>("");
      ref.track_count = p["track_count"].As<int>(0);
      out.push_back(std::move(ref));
    }
  }
  return out;
}

std::vector<std::int64_t> YandexMusicGateway::FetchLikedTracks(const std::string& personal_token,
                                                               const std::string& user_id,
                                                               Lane lane) const {
  const std::string url = yandex_base_url_ + "/users/" + user_id + "/likes/tracks";
  const auto json = formats::json::FromString(YandexGetWithToken(url, lane, personal_token));
  const auto& tracks = json["result"]["tracks"];

  std::vector<std::int64_t> out;
  if (tracks.IsArray()) {
    out.reserve(tracks.GetSize());
    for (const auto& t : tracks) {
      const auto tid = t.As<std::int64_t>(0);
      if (tid) out.push_back(tid);
    }
  }
  return out;
}

std::vector<std::int64_t> YandexMusicGateway::FetchPlaylistTracks(const std::string& personal_token,
                                                                  const std::string& user_id,
                                                                  std::int64_t playlist_id,
                                                                  Lane lane) const {
  const std::string url =
      yandex_base_url_ + "/users/" + user_id + "/playlists/" + std::to_string(playlist_id);
  const auto json = formats::json::FromString(YandexGetWithToken(url, lane, personal_token));
  const auto& tracks = json["result"]["tracks"];

  std::vector<std::int64_t> out;
  if (tracks.IsArray()) {
    out.reserve(tracks.GetSize());
    for (const auto& t : tracks) {
      const auto tid = t.As<std::int64_t>(0);
      if (tid) out.push_back(tid);
    }
  }
  return out;
}

std::optional<std::string> YandexMusicGateway::FetchAccountUserId(const std::string& personal_token,
                                                                  Lane lane) const {
  const std::string url = yandex_base_url_ + "/account/status";
  const auto json = formats::json::FromString(YandexGetWithToken(url, lane, personal_token));
  const auto uid = json["result"]["account"]["uid"].As<std::int64_t>(0);
  if (!uid) return std::nullopt;
  return std::to_string(uid);
}

std::vector<std::int64_t> YandexMusicGateway::FetchArtistTracks(std::int64_t artist_id,
                                                                int limit,
                                                                Lane lane) const {
  const std::string url = yandex_base_url_ + "/artists/" + std::to_string(artist_id) +
                          "/tracks?limit=" + std::to_string(limit);
  const auto json = formats::json::FromString(YandexGet(url, lane));
  const auto& tracks = json["result"]["tracks"];

  std::vector<std::int64_t> out;
  if (tracks.IsArray()) {
    out.reserve(tracks.GetSize());
    for (const auto& t : tracks) {
      const auto tid = t.As<std::int64_t>(0);
      if (tid) out.push_back(tid);
    }
  }
  return out;
}

yaml_config::Schema YandexMusicGateway::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kYandexMusicGatewayComponentSchema);
}

}  // namespace six_feat
