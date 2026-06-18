#include "graph_handler.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

std::string UrlEncode(std::string_view value) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(value.size() * 3);
  for (unsigned char c : value) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('%');
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0x0F]);
    }
  }
  return out;
}

std::string ToLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return value;
}

std::string EmptyGraph() {
  return R"({"seed":"","seed_id":0,"nodes":[],"edges":[]})";
}

struct Collab {
  std::string song;
  std::vector<std::string> roles;
};

struct EdgeAgg {
  int weight{0};
  std::vector<Collab> collaborations;
};

std::vector<ArtistRef> ParseArtistArray(const formats::json::Value &arr) {
  if (!arr.IsArray())
    return {};
  std::vector<ArtistRef> out;
  out.reserve(arr.GetSize());
  for (const auto &a : arr) {
    const auto id = a["id"].As<std::int64_t>(0);
    if (id == 0)
      continue;
    out.push_back({id, a["name"].As<std::string>(""),
                   a["image_url"].As<std::string>("")});
  }
  return out;
}

std::optional<SongDetail> FetchSongDetail(clients::http::Client &client,
                                          const std::string &url,
                                          const std::string &auth) {
  try {
    const auto resp = client.CreateRequest()
                          .get(url)
                          .headers({{"Authorization", auth}})
                          .timeout(std::chrono::milliseconds{3000})
                          .retry(1)
                          .perform();
    if (!resp->IsOk()) {
      LOG_WARNING() << "song detail HTTP " << resp->status_code() << " for "
                    << url;
      return std::nullopt;
    }

    const auto json = formats::json::FromString(resp->body());
    const auto &song = json["response"]["song"];
    if (!song.IsObject())
      return std::nullopt;

    SongDetail d;
    d.title = song["title"].As<std::string>("");
    if (d.title.empty())
      d.title = song["full_title"].As<std::string>("");

    if (song.HasMember("primary_artist")) {
      const auto &p = song["primary_artist"];
      d.primary = {p["id"].As<std::int64_t>(0), p["name"].As<std::string>(""),
                   p["image_url"].As<std::string>("")};
    }
    d.producers = ParseArtistArray(song["producer_artists"]);
    d.writers = ParseArtistArray(song["writer_artists"]);
    d.featured = ParseArtistArray(song["featured_artists"]);
    return d;
  } catch (const std::exception &e) {
    LOG_WARNING() << "song detail fetch/parse failed for " << url << ": "
                  << e.what();
    return std::nullopt;
  }
}

} // namespace

GraphHandler::GraphHandler(const components::ComponentConfig &config,
                           const components::ComponentContext &context)
    : HttpHandlerBase(config, context),
      http_client_(
          context.FindComponent<components::HttpClient>().GetHttpClient()),
      genius_token_(config["genius-api-token"].As<std::string>()),
      genius_base_url_(
          config["genius-base-url"].As<std::string>("https://api.genius.com")),
      songs_limit_(config["songs-limit"].As<int>(15)) {}

std::string GraphHandler::HandleRequestThrow(
    const server::http::HttpRequest &request,
    server::request::RequestContext & /*context*/) const {
  auto &response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const std::string &artist = request.GetArg("artist");
  if (artist.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return R"({"error":"query parameter 'artist' is required","nodes":[],"edges":[]})";
  }

  const std::string cache_key = ToLower(artist);
  {
    std::shared_lock lock(artist_cache_mutex_);
    const auto it = artist_cache_.find(cache_key);
    if (it != artist_cache_.end())
      return it->second;
  }

  std::string result;
  try {
    result = BuildGraphJson(artist);
  } catch (const std::exception &e) {
    LOG_ERROR() << "graph build failed for '" << artist << "': " << e.what();
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return R"({"error":"could not reach Genius, try again","nodes":[],"edges":[]})";
  }

  {
    std::unique_lock lock(artist_cache_mutex_);
    artist_cache_.emplace(cache_key, result);
  }
  return result;
}

std::string GraphHandler::BuildGraphJson(const std::string &artist_name) const {
  const std::string auth = "Bearer " + genius_token_;

  std::string search_url;
  search_url.reserve(genius_base_url_.size() + 10 + artist_name.size() * 3);
  search_url = genius_base_url_;
  search_url += "/search?q=";
  search_url += UrlEncode(artist_name);

  const auto search_resp = http_client_.CreateRequest()
                               .get(search_url)
                               .headers({{"Authorization", auth}})
                               .timeout(std::chrono::seconds{5})
                               .retry(2)
                               .perform();
  if (!search_resp->IsOk()) {
    throw std::runtime_error("Genius /search returned HTTP " +
                             std::to_string(search_resp->status_code()));
  }

  const auto search_json = formats::json::FromString(search_resp->body());
  const auto hits = search_json["response"]["hits"];
  if (!hits.IsArray() || hits.IsEmpty())
    return EmptyGraph();

  std::int64_t seed_id = 0;
  std::string seed_name;
  std::string seed_image;

  for (const auto &hit : hits) {
    const auto &p = hit["result"]["primary_artist"];
    auto name = p["name"].As<std::string>("");
    if (ToLower(name) == ToLower(artist_name)) {
      seed_id = p["id"].As<std::int64_t>(0);
      seed_name = std::move(name);
      seed_image = p["image_url"].As<std::string>("");
      break;
    }
  }
  if (seed_id == 0) {
    const auto &p = hits[0]["result"]["primary_artist"];
    seed_id = p["id"].As<std::int64_t>(0);
    seed_name = p["name"].As<std::string>("");
    seed_image = p["image_url"].As<std::string>("");
  }

  std::string songs_url;
  songs_url.reserve(genius_base_url_.size() + 48);
  songs_url = genius_base_url_;
  songs_url += "/artists/";
  songs_url += std::to_string(seed_id);
  songs_url += "/songs?sort=popularity&per_page=";
  songs_url += std::to_string(songs_limit_);

  const auto songs_resp = http_client_.CreateRequest()
                              .get(songs_url)
                              .headers({{"Authorization", auth}})
                              .timeout(std::chrono::seconds{5})
                              .retry(2)
                              .perform();
  if (!songs_resp->IsOk()) {
    throw std::runtime_error("Genius /artists/:id/songs returned HTTP " +
                             std::to_string(songs_resp->status_code()));
  }

  const auto songs_json = formats::json::FromString(songs_resp->body());
  const auto songs = songs_json["response"]["songs"];

  std::vector<std::int64_t> song_ids;
  if (songs.IsArray()) {
    song_ids.reserve(songs.GetSize());
    for (const auto &s : songs) {
      const auto sid = s["id"].As<std::int64_t>(0);
      if (sid != 0)
        song_ids.push_back(sid);
    }
  }

  struct Pending {
    std::int64_t song_id;
    engine::TaskWithResult<std::optional<SongDetail>> task;
  };

  std::vector<SongDetail> details;
  details.reserve(song_ids.size());
  std::vector<Pending> pending;
  pending.reserve(song_ids.size());

  {
    std::lock_guard lock(song_cache_mutex_);
    for (const auto sid : song_ids) {
      const auto it = song_cache_.find(sid);
      if (it != song_cache_.end()) {
        if (it->second)
          details.push_back(*it->second);
        continue;
      }
      song_cache_.emplace(sid, std::nullopt);

      std::string url = genius_base_url_ + "/songs/" + std::to_string(sid);
      pending.push_back({sid, utils::Async("fetch-song-detail",
                                           [this, url = std::move(url), auth] {
                                             return FetchSongDetail(
                                                 http_client_, url, auth);
                                           })});
    }
  }

  for (auto &p : pending) {
    try {
      auto detail = p.task.Get();
      {
        std::lock_guard lock(song_cache_mutex_);
        song_cache_[p.song_id] = detail; // update nullopt placeholder
      }
      if (detail)
        details.push_back(std::move(*detail));
    } catch (const std::exception &e) {
      LOG_WARNING() << "song-detail task failed (sid=" << p.song_id
                    << "): " << e.what();
    }
  }

  std::unordered_map<std::int64_t, std::string> names;
  std::unordered_map<std::int64_t, std::string> images;
  std::unordered_map<std::int64_t, EdgeAgg> edges_by_id;
  std::vector<std::int64_t> collaborator_order;
  names.reserve(details.size() * 4);
  images.reserve(details.size() * 4);
  edges_by_id.reserve(details.size() * 4);
  collaborator_order.reserve(details.size() * 3);

  names[seed_id] = seed_name;
  if (!seed_image.empty())
    images[seed_id] = seed_image;

  for (const auto &d : details) {
    std::unordered_map<std::int64_t, std::vector<std::string>> track_roles;
    std::unordered_map<std::int64_t, std::string> track_names;
    std::unordered_map<std::int64_t, std::string> track_images;
    track_roles.reserve(8);

    const auto note = [&](const ArtistRef &a, std::string role) {
      if (a.id == 0)
        return;
      track_names[a.id] = a.name;
      if (!a.image.empty())
        track_images[a.id] = a.image;
      auto &roles = track_roles[a.id];
      if (std::find(roles.begin(), roles.end(), role) == roles.end())
        roles.push_back(std::move(role));
    };

    note(d.primary, "primary");
    for (const auto &a : d.producers)
      note(a, "producer");
    for (const auto &a : d.writers)
      note(a, "writer");
    for (const auto &a : d.featured)
      note(a, "featured");

    for (auto &[gid, roles] : track_roles) {
      if (gid == seed_id)
        continue;
      if (!names.count(gid))
        names[gid] = track_names[gid];
      if (!images.count(gid)) {
        const auto iit = track_images.find(gid);
        if (iit != track_images.end())
          images[gid] = iit->second;
      }

      auto &agg = edges_by_id[gid];
      if (agg.weight == 0)
        collaborator_order.push_back(gid);
      ++agg.weight;
      agg.collaborations.push_back({d.title, std::move(roles)});
    }
  }

  formats::json::ValueBuilder nodes_b(formats::json::Type::kArray);
  formats::json::ValueBuilder edges_b(formats::json::Type::kArray);

  const auto emit_node = [&](std::int64_t gid) {
    formats::json::ValueBuilder nb(formats::json::Type::kObject);
    nb["id"] = gid;
    const auto nit = names.find(gid);
    nb["label"] = nit != names.end() ? nit->second : std::string{};
    const auto iit = images.find(gid);
    if (iit != images.end() && !iit->second.empty())
      nb["image"] = iit->second;
    nodes_b.PushBack(std::move(nb));
  };

  emit_node(seed_id);

  for (const auto gid : collaborator_order) {
    emit_node(gid);
    const auto &agg = edges_by_id[gid];

    formats::json::ValueBuilder eb(formats::json::Type::kObject);
    eb["from"] = seed_id;
    eb["to"] = gid;
    eb["weight"] = agg.weight;

    formats::json::ValueBuilder cb(formats::json::Type::kArray);
    for (const auto &c : agg.collaborations) {
      formats::json::ValueBuilder c_item(formats::json::Type::kObject);
      c_item["song"] = c.song;
      formats::json::ValueBuilder rb(formats::json::Type::kArray);
      for (const auto &r : c.roles)
        rb.PushBack(r);
      c_item["roles"] = std::move(rb);
      cb.PushBack(std::move(c_item));
    }
    eb["collaborations"] = std::move(cb);
    edges_b.PushBack(std::move(eb));
  }

  formats::json::ValueBuilder graph(formats::json::Type::kObject);
  graph["seed"] = seed_name;
  graph["seed_id"] = seed_id;
  graph["nodes"] = std::move(nodes_b);
  graph["edges"] = std::move(edges_b);
  return formats::json::ToString(graph.ExtractValue());
}

yaml_config::Schema GraphHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(R"(
type: object
description: Builds an artist collaboration graph from the Genius API
additionalProperties: false
properties:
    genius-api-token:
        type: string
        description: Client Access Token for api.genius.com (sent as Bearer)
    genius-base-url:
        type: string
        description: Base URL of the Genius API
        defaultDescription: https://api.genius.com
    songs-limit:
        type: integer
        description: How many popular songs per artist to scan for features
        defaultDescription: '15'
)");
}

} // namespace six_feat
