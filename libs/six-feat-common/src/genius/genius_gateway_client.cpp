#include "genius/genius_gateway_client.hpp"

#include "core/internal_auth.hpp"
#include "core/internal_http.hpp"
#include "core/request_id.hpp"

#include "schemas/components/genius_gateway_client_schema.hpp"

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
    throw std::runtime_error("genius-gateway-client: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

double RequirePositive(std::string_view param, double value) {
  if (!(value > 0.0)) {
    throw std::runtime_error("genius-gateway-client: " + std::string(param) +
                             " must be a positive number, got " + std::to_string(value));
  }
  return value;
}

std::string LaneToString(Lane lane) {
  return lane == Lane::Foreground ? "foreground" : "background";
}

}  // namespace
GeniusGatewayClient::GeniusGatewayClient(const components::ComponentConfig& config,
                                         const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      base_url_(config["genius-gateway-base-url"].As<std::string>()),
      shared_secret_(internal_api::SharedSecretFromEnv()),
      timeout_(std::chrono::milliseconds{
          RequirePositive("timeout-ms", config["timeout-ms"].As<int>(5000))}),
      songs_limit_fg_(RequirePositive("songs-limit-fg", config["songs-limit-fg"].As<int>(40))),
      songs_limit_bg_(RequirePositive("songs-limit-bg", config["songs-limit-bg"].As<int>(80))),
      match_threshold_(
          RequirePositive("match-threshold", config["match-threshold"].As<double>(0.75))) {}

yaml_config::Schema GeniusGatewayClient::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kGeniusGatewayClientComponentSchema);
}

formats::json::Value GeniusGatewayClient::PostInternal(const std::string& path,
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
          status, "genius-gateway-client: HTTP " + std::to_string(status) + " from " + path};
    }
    return formats::json::FromString(resp.body);
  } catch (const GeniusHttpError&) {
    throw;
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[GWClient] request_id=" << request_id << " " << path
                  << " failed: " << ex.what();
    throw GeniusHttpError{502, "genius-gateway-client: request failed: " + std::string(ex.what())};
  }
}

std::vector<Candidate> GeniusGatewayClient::ResolveCandidates(const std::string& query,
                                                              const std::string& user_token) const {
  formats::json::ValueBuilder body(formats::json::Type::kObject);
  body["query"] = query;
  body["user_token"] = user_token;

  const auto json = PostInternal("/internal/genius/candidates", body);
  const auto& arr = json["candidates"];

  std::vector<Candidate> out;
  if (arr.IsArray()) {
    out.reserve(arr.GetSize());
    for (const auto& c : arr) {
      Candidate cand;
      cand.id = c["id"].As<std::int64_t>(0);
      cand.name = c["name"].As<std::string>("");
      cand.image = c["image"].As<std::string>("");
      cand.url = c["url"].As<std::string>("");
      cand.score = c["score"].As<double>(0.0);
      out.push_back(std::move(cand));
    }
  }
  return out;
}

std::optional<ArtistRef> GeniusGatewayClient::FetchArtistById(std::int64_t id,
                                                              Lane lane,
                                                              const std::string& user_token) const {
  try {
    formats::json::ValueBuilder body(formats::json::Type::kObject);
    body["id"] = id;
    body["lane"] = LaneToString(lane);
    body["user_token"] = user_token;

    const auto json = PostInternal("/internal/genius/artist", body);
    if (!json["found"].As<bool>(false)) return std::nullopt;

    return ArtistRef{json["id"].As<std::int64_t>(id),
                     json["name"].As<std::string>(""),
                     json["image"].As<std::string>(""),
                     json["url"].As<std::string>("")};
  } catch (const GeniusHttpError& e) {
    if (e.status_code == 401) throw;
    LOG_WARNING() << "[GWClient] FetchArtistById(" << id << "): " << e.what();
    return std::nullopt;
  }
}

std::vector<std::int64_t> GeniusGatewayClient::FetchSongList(std::int64_t artist_id,
                                                             int limit,
                                                             Lane lane,
                                                             const std::string& user_token) const {
  formats::json::ValueBuilder body(formats::json::Type::kObject);
  body["artist_id"] = artist_id;
  body["limit"] = limit;
  body["lane"] = LaneToString(lane);
  body["user_token"] = user_token;

  const auto json = PostInternal("/internal/genius/song-list", body);
  const auto& arr = json["song_ids"];

  std::vector<std::int64_t> ids;
  if (arr.IsArray()) {
    ids.reserve(arr.GetSize());
    for (const auto& v : arr) {
      const auto sid = v.As<std::int64_t>(0);
      if (sid) ids.push_back(sid);
    }
  }
  return ids;
}

std::optional<SongRecord> GeniusGatewayClient::FetchSongDetail(
    std::int64_t song_id, Lane lane, const std::string& user_token) const {
  try {
    formats::json::ValueBuilder body(formats::json::Type::kObject);
    body["song_id"] = song_id;
    body["lane"] = LaneToString(lane);
    body["user_token"] = user_token;

    const auto json = PostInternal("/internal/genius/song", body);
    if (!json["found"].As<bool>(false)) return std::nullopt;

    const auto& song = json["song"];
    SongRecord rec;
    rec.id = song["id"].As<std::int64_t>(song_id);
    rec.title = song["title"].As<std::string>("");
    rec.popularity = song["popularity"].As<std::int64_t>(0);

    const auto& credits = song["credits"];
    if (credits.IsArray()) {
      rec.credits.reserve(credits.GetSize());
      for (const auto& c : credits) {
        const auto& a = c["artist"];
        ArtistRef artist{a["id"].As<std::int64_t>(0),
                         a["name"].As<std::string>(""),
                         a["image"].As<std::string>(""),
                         a["url"].As<std::string>("")};
        rec.credits.push_back({std::move(artist), c["role"].As<std::string>("")});
      }
    }
    return rec;
  } catch (const GeniusHttpError& e) {
    if (e.status_code == 401) throw;
    LOG_WARNING() << "[GWClient] FetchSongDetail(" << song_id << "): " << e.what();
    return std::nullopt;
  }
}

}  // namespace six_feat