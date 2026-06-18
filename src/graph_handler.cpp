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

// Minimal, dependency-free RFC 3986 percent-encoding for the query string.
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

std::string EmptyGraph() { return R"({"seed":"","nodes":[],"edges":[]})"; }

// ---- value objects shared between the parallel fetch and the aggregation ----

struct ArtistRef {
  std::int64_t id{0};
  std::string name;
  std::string image;  // Genius image_url (square artist photo); may be empty
};

// Everything we care about from a single /songs/{id} response.
struct SongDetail {
  std::string title;
  ArtistRef primary;
  std::vector<ArtistRef> producers;
  std::vector<ArtistRef> writers;
  std::vector<ArtistRef> featured;
};

// One collaboration record attached to an edge: which track and in what roles.
struct Collab {
  std::string song;
  std::vector<std::string> roles;
};

// Aggregated edge seed -> collaborator.
struct EdgeAgg {
  int weight{0};
  std::vector<Collab> collaborations;
};

// Parse a Genius "*_artists" array into a flat list, skipping malformed items.
std::vector<ArtistRef> ParseArtistArray(const formats::json::Value& arr) {
  std::vector<ArtistRef> out;
  if (!arr.IsArray()) return out;
  out.reserve(arr.GetSize());
  for (const auto& a : arr) {
    const auto id = a["id"].As<std::int64_t>(0);
    if (id == 0) continue;
    out.push_back(ArtistRef{id, a["name"].As<std::string>(""),
                            a["image_url"].As<std::string>("")});
  }
  return out;
}

// Worker body run on a separate task per song. PURE with respect to the
// handler's shared state: it only reads its inputs + the thread-safe HTTP
// client and returns a parsed value. Any failure (timeout, non-2xx, bad JSON)
// is swallowed and reported as std::nullopt so one bad track can't sink the
// whole request.
std::optional<SongDetail> FetchSongDetail(clients::http::Client& client,
                                          const std::string& url,
                                          const std::string& auth) {
  try {
    const auto resp = client.CreateRequest()
                          .get(url)
                          .headers({{"Authorization", auth}})
                          .timeout(std::chrono::seconds{5})
                          .retry(2)
                          .perform();
    if (!resp->IsOk()) {
      LOG_WARNING() << "song detail HTTP " << resp->status_code() << " for "
                    << url;
      return std::nullopt;
    }

    const auto json = formats::json::FromString(resp->body());
    const auto& song = json["response"]["song"];
    if (!song.IsObject()) return std::nullopt;

    SongDetail d;
    d.title = song["title"].As<std::string>("");
    if (d.title.empty()) d.title = song["full_title"].As<std::string>("");

    if (song.HasMember("primary_artist")) {
      const auto& p = song["primary_artist"];
      d.primary = ArtistRef{p["id"].As<std::int64_t>(0),
                            p["name"].As<std::string>(""),
                            p["image_url"].As<std::string>("")};
    }
    d.producers = ParseArtistArray(song["producer_artists"]);
    d.writers = ParseArtistArray(song["writer_artists"]);
    d.featured = ParseArtistArray(song["featured_artists"]);
    return d;
  } catch (const std::exception& e) {
    LOG_WARNING() << "song detail fetch/parse failed for " << url << ": "
                  << e.what();
    return std::nullopt;
  }
}

}  // namespace

GraphHandler::GraphHandler(const components::ComponentConfig& config,
                           const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      http_client_(
          context.FindComponent<components::HttpClient>().GetHttpClient()),
      genius_token_(config["genius-api-token"].As<std::string>()),
      genius_base_url_(
          config["genius-base-url"].As<std::string>("https://api.genius.com")),
      songs_limit_(config["songs-limit"].As<int>(15)) {}

std::string GraphHandler::HandleRequestThrow(
    const server::http::HttpRequest& request,
    server::request::RequestContext& /*context*/) const {
  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const std::string& artist = request.GetArg("artist");
  if (artist.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return R"({"error":"query parameter 'artist' is required","nodes":[],"edges":[]})";
  }

  const std::string cache_key = ToLower(artist);
  {
    std::lock_guard<engine::Mutex> lock(cache_mutex_);
    const auto it = cache_.find(cache_key);
    if (it != cache_.end()) return it->second;
  }

  std::string result;
  try {
    result = BuildGraphJson(artist);
  } catch (const std::exception& e) {
    LOG_ERROR() << "graph build failed for '" << artist << "': " << e.what();
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return R"({"error":"could not reach Genius, try again","nodes":[],"edges":[]})";
  }

  {
    std::lock_guard<engine::Mutex> lock(cache_mutex_);
    cache_[cache_key] = result;
  }
  return result;
}

std::string GraphHandler::BuildGraphJson(const std::string& artist_name) const {
  const std::string auth = "Bearer " + genius_token_;

  // --- Step 1: find the artist via /search --------------------------------
  const std::string search_url =
      genius_base_url_ + "/search?q=" + UrlEncode(artist_name);

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
  if (!hits.IsArray() || hits.IsEmpty()) return EmptyGraph();

  // Prefer an exact (case-insensitive) name match; fall back to the first hit.
  std::int64_t seed_id = 0;
  std::string seed_name;
  std::string seed_image;
  for (const auto& hit : hits) {
    const auto& primary = hit["result"]["primary_artist"];
    auto current_name = primary["name"].As<std::string>("");
    if (ToLower(current_name) == ToLower(artist_name)) {
      seed_id = primary["id"].As<std::int64_t>(0);
      seed_name = std::move(current_name);
      seed_image = primary["image_url"].As<std::string>("");
      break;
    }
  }
  if (seed_id == 0) {
    const auto& seed = hits[0]["result"]["primary_artist"];
    seed_id = seed["id"].As<std::int64_t>(0);
    seed_name = seed["name"].As<std::string>("");
    seed_image = seed["image_url"].As<std::string>("");
  }

  // --- Step 2: list the seed artist's popular songs -----------------------
  const std::string songs_url =
      genius_base_url_ + "/artists/" + std::to_string(seed_id) +
      "/songs?sort=popularity&per_page=" + std::to_string(songs_limit_);

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
    for (const auto& s : songs) {
      const auto sid = s["id"].As<std::int64_t>(0);
      if (sid != 0) song_ids.push_back(sid);
    }
  }

  // --- Step 2.5: fan out /songs/{id} requests IN PARALLEL -----------------
  // Each request becomes its own task on the current task processor. Because
  // the HTTP calls suspend the coroutine on I/O, all of them are in flight at
  // once, so the added latency is ~one round-trip, not N of them.
  std::vector<engine::TaskWithResult<std::optional<SongDetail>>> tasks;
  tasks.reserve(song_ids.size());
  for (const auto sid : song_ids) {
    std::string url = genius_base_url_ + "/songs/" + std::to_string(sid);
    tasks.push_back(utils::Async(
        "fetch-song-detail",
        [this, url = std::move(url), auth] {
          return FetchSongDetail(http_client_, url, auth);
        }));
  }

  // Collect results. Get() rethrows a task's stored exception, and a task may
  // also be cancelled on deadline — in both cases we just drop that track.
  std::vector<SongDetail> details;
  details.reserve(tasks.size());
  for (auto& task : tasks) {
    try {
      auto detail = task.Get();
      if (detail) details.push_back(std::move(*detail));
    } catch (const std::exception& e) {
      LOG_WARNING() << "song-detail task failed: " << e.what();
    }
  }

  // --- Step 3: aggregate into a weighted graph (serial, single coroutine) -
  // No locks needed: every parallel task above was pure, and this aggregation
  // runs only here, in one coroutine, after all tasks have been joined. So
  // names / images / edges_by_id are touched by exactly one thread.
  std::unordered_map<std::int64_t, std::string> names;   // gid -> display name
  std::unordered_map<std::int64_t, std::string> images;  // gid -> image_url
  std::unordered_map<std::int64_t, EdgeAgg> edges_by_id;  // collaborator gid
  std::vector<std::int64_t> collaborator_order;           // stable output order
  names[seed_id] = seed_name;
  if (!seed_image.empty()) images[seed_id] = seed_image;

  for (const auto& d : details) {
    // Roles this track assigns to each involved artist (deduped, ordered).
    std::unordered_map<std::int64_t, std::vector<std::string>> track_roles;
    std::unordered_map<std::int64_t, std::string> track_names;
    std::unordered_map<std::int64_t, std::string> track_images;

    const auto note = [&](const ArtistRef& a, std::string role) {
      if (a.id == 0) return;
      track_names[a.id] = a.name;
      if (!a.image.empty()) track_images[a.id] = a.image;
      auto& roles = track_roles[a.id];
      if (std::find(roles.begin(), roles.end(), role) == roles.end()) {
        roles.push_back(std::move(role));
      }
    };

    note(d.primary, "primary");
    for (const auto& a : d.producers) note(a, "producer");
    for (const auto& a : d.writers) note(a, "writer");
    for (const auto& a : d.featured) note(a, "featured");

    // Connect the seed to every *other* artist on this track.
    for (auto& [gid, roles] : track_roles) {
      if (gid == seed_id) continue;
      if (names.find(gid) == names.end()) names[gid] = track_names[gid];
      if (images.find(gid) == images.end()) {
        const auto iit = track_images.find(gid);
        if (iit != track_images.end()) images[gid] = iit->second;
      }

      auto& agg = edges_by_id[gid];
      if (agg.weight == 0) collaborator_order.push_back(gid);
      ++agg.weight;
      agg.collaborations.push_back(Collab{d.title, std::move(roles)});
    }
  }

  // --- Step 4: serialize {seed, seed_id, nodes, edges} --------------------
  // Node "id" is the real Genius artist id (global, int64). This makes the
  // payload mergeable on the client: expanding a new artist can never collide
  // with nodes already on screen, because ids are globally unique.
  formats::json::ValueBuilder nodes(formats::json::Type::kArray);

  const auto emit_node = [&](std::int64_t gid) {
    formats::json::ValueBuilder node(formats::json::Type::kObject);
    node["id"] = gid;  // global Genius id, not a per-request local index
    const auto nit = names.find(gid);
    node["label"] = nit != names.end() ? nit->second : std::string{};
    const auto iit = images.find(gid);
    if (iit != images.end() && !iit->second.empty()) {
      node["image"] = iit->second;  // frontend falls back to a placeholder if absent
    }
    nodes.PushBack(std::move(node));
  };

  emit_node(seed_id);  // the focused artist

  // collaborator_order holds unique gids (seed excluded), so every node and
  // edge below is emitted exactly once per response.
  formats::json::ValueBuilder edges(formats::json::Type::kArray);
  for (const auto gid : collaborator_order) {
    emit_node(gid);
    const auto& agg = edges_by_id[gid];

    formats::json::ValueBuilder edge(formats::json::Type::kObject);
    edge["from"] = seed_id;
    edge["to"] = gid;
    edge["weight"] = agg.weight;

    formats::json::ValueBuilder collabs(formats::json::Type::kArray);
    for (const auto& c : agg.collaborations) {
      formats::json::ValueBuilder cb(formats::json::Type::kObject);
      cb["song"] = c.song;
      formats::json::ValueBuilder rb(formats::json::Type::kArray);
      for (const auto& r : c.roles) rb.PushBack(r);
      cb["roles"] = std::move(rb);
      collabs.PushBack(std::move(cb));
    }
    edge["collaborations"] = std::move(collabs);
    edges.PushBack(std::move(edge));
  }

  formats::json::ValueBuilder graph(formats::json::Type::kObject);
  graph["seed"] = seed_name;
  graph["seed_id"] = seed_id;  // lets the client highlight the focused node
  graph["nodes"] = std::move(nodes);
  graph["edges"] = std::move(edges);
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

}  // namespace six_feat
