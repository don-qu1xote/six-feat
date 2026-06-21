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
#include <unordered_set>
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

// Lowercase + collapse whitespace for fuzzy comparison.
std::string NormalizeName(std::string_view value) {
  std::string out;
  out.reserve(value.size());
  bool prev_space = false;
  for (unsigned char c : value) {
    if (std::isspace(c)) {
      if (!out.empty() && !prev_space)
        out.push_back(' ');
      prev_space = true;
    } else {
      out.push_back(static_cast<char>(std::tolower(c)));
      prev_space = false;
    }
  }
  while (!out.empty() && out.back() == ' ')
    out.pop_back();
  return out;
}

// Classic Levenshtein edit distance (byte-wise; fine for Latin artist names).
int Levenshtein(const std::string &a, const std::string &b) {
  const std::size_t n = a.size(), m = b.size();
  if (n == 0)
    return static_cast<int>(m);
  if (m == 0)
    return static_cast<int>(n);
  std::vector<int> prev(m + 1), cur(m + 1);
  for (std::size_t j = 0; j <= m; ++j)
    prev[j] = static_cast<int>(j);
  for (std::size_t i = 1; i <= n; ++i) {
    cur[0] = static_cast<int>(i);
    for (std::size_t j = 1; j <= m; ++j) {
      const int cost = (a[i - 1] == b[j - 1]) ? 0 : 1;
      cur[j] = std::min({prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost});
    }
    std::swap(prev, cur);
  }
  return prev[m];
}

// Similarity in [0, 1]. 1.0 == exact match.
double Similarity(const std::string &a, const std::string &b) {
  if (a == b)
    return 1.0;
  const std::size_t maxlen = std::max(a.size(), b.size());
  if (maxlen == 0)
    return 1.0;
  const int d = Levenshtein(a, b);
  double sim = 1.0 - static_cast<double>(d) / static_cast<double>(maxlen);
  // Substring boost: "kendrick" vs "kendrick lamar" should rank highly.
  if (!a.empty() && !b.empty() &&
      (a.find(b) != std::string::npos || b.find(a) != std::string::npos)) {
    sim = std::max(sim, 0.90);
  }
  return sim;
}

// Role significance: producer > writer > featured > primary.
int RoleRank(std::string_view role) {
  if (role == "producer")
    return 4;
  if (role == "writer")
    return 3;
  if (role == "featured")
    return 2;
  if (role == "primary")
    return 1;
  return 0;
}

RoleMask ParseRoleMask(const std::string &spec) {
  if (spec.empty())
    return RoleMask{}; // absent => keep everything
  RoleMask m{false, false, false, false};
  std::size_t start = 0;
  while (start <= spec.size()) {
    const std::size_t comma = spec.find(',', start);
    std::string tok = ToLower(spec.substr(
        start, comma == std::string::npos ? std::string::npos : comma - start));
    if (tok == "primary")
      m.primary = true;
    else if (tok == "producer")
      m.producer = true;
    else if (tok == "writer")
      m.writer = true;
    else if (tok == "featured")
      m.featured = true;
    if (comma == std::string::npos)
      break;
    start = comma + 1;
  }
  return m;
}

std::string MaskKey(const RoleMask &m) {
  std::string k = "r";
  k += m.primary ? '1' : '0';
  k += m.producer ? '1' : '0';
  k += m.writer ? '1' : '0';
  k += m.featured ? '1' : '0';
  return k;
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
  int best_rank{0};
  std::string role_priority{"featured"}; // dominant role for edge color
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
                   a["image_url"].As<std::string>(""),
                   a["url"].As<std::string>("")});
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
                   p["image_url"].As<std::string>(""),
                   p["url"].As<std::string>("")};
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
      songs_limit_(config["songs-limit"].As<int>(15)),
      match_threshold_(config["match-threshold"].As<double>(0.9)) {}

std::string GraphHandler::HandleRequestThrow(
    const server::http::HttpRequest &request,
    server::request::RequestContext & /*context*/) const {
  auto &response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const RoleMask mask = ParseRoleMask(request.GetArg("roles"));
  const std::string mask_key = MaskKey(mask);

  // ---- Resolve the seed artist -------------------------------------------
  ArtistRef seed;
  const std::string &id_arg = request.GetArg("id");

  if (!id_arg.empty()) {
    std::int64_t id = 0;
    try {
      id = std::stoll(id_arg);
    } catch (const std::exception &) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return R"({"error":"'id' must be numeric","nodes":[],"edges":[]})";
    }

    const std::string cache_key = "id:" + std::to_string(id) + "|" + mask_key;
    {
      std::shared_lock lock(graph_cache_mutex_);
      const auto it = graph_cache_.find(cache_key);
      if (it != graph_cache_.end())
        return it->second;
    }
    std::optional<ArtistRef> fetched;
    try {
      fetched = FetchArtist(id);
    } catch (const std::exception &e) {
      LOG_ERROR() << "FetchArtist failed for id=" << id << ": " << e.what();
      response.SetStatus(server::http::HttpStatus::kBadGateway);
      return R"({"error":"could not reach Genius, try again","nodes":[],"edges":[]})";
    }
    if (!fetched)
      return EmptyGraph();
    seed = std::move(*fetched);
  } else {
    const std::string &artist = request.GetArg("artist");
    if (artist.empty()) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return R"({"error":"query parameter 'artist' or 'id' is required","nodes":[],"edges":[]})";
    }

    std::vector<Candidate> candidates;
    try {
      candidates = ResolveCandidates(artist);
    } catch (const std::exception &e) {
      LOG_ERROR() << "candidate resolution failed for '" << artist
                  << "': " << e.what();
      response.SetStatus(server::http::HttpStatus::kBadGateway);
      return R"({"error":"could not reach Genius, try again","nodes":[],"edges":[]})";
    }
    if (candidates.empty())
      return EmptyGraph();

    const Candidate &best = candidates.front();
    if (best.score < match_threshold_) {
      // Ambiguous: return a "Did you mean?" list instead of a graph.
      formats::json::ValueBuilder out(formats::json::Type::kObject);
      out["ambiguous"] = true;
      out["query"] = artist;
      formats::json::ValueBuilder arr(formats::json::Type::kArray);
      std::size_t limit = std::min<std::size_t>(candidates.size(), 6);
      for (std::size_t i = 0; i < limit; ++i) {
        const auto &c = candidates[i];
        formats::json::ValueBuilder cb(formats::json::Type::kObject);
        cb["id"] = c.id;
        cb["name"] = c.name;
        if (!c.image.empty())
          cb["image"] = c.image;
        if (!c.url.empty())
          cb["url"] = c.url;
        cb["score"] = c.score;
        arr.PushBack(std::move(cb));
      }
      out["candidates"] = std::move(arr);
      return formats::json::ToString(out.ExtractValue());
    }

    seed = {best.id, best.name, best.image, best.url};
  }

  // ---- Build (or serve cached) graph for the resolved seed ---------------
  const std::string cache_key =
      "id:" + std::to_string(seed.id) + "|" + mask_key;
  {
    std::shared_lock lock(graph_cache_mutex_);
    const auto it = graph_cache_.find(cache_key);
    if (it != graph_cache_.end())
      return it->second;
  }

  std::string result;
  try {
    result = BuildGraphForSeed(seed, mask);
  } catch (const std::exception &e) {
    LOG_ERROR() << "graph build failed for '" << seed.name << "': " << e.what();
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return R"({"error":"could not reach Genius, try again","nodes":[],"edges":[]})";
  }

  {
    std::unique_lock lock(graph_cache_mutex_);
    graph_cache_.emplace(cache_key, result);
  }
  return result;
}

std::vector<Candidate>
GraphHandler::ResolveCandidates(const std::string &query) const {
  const std::string auth = "Bearer " + genius_token_;
  const std::string url = genius_base_url_ + "/search?q=" + UrlEncode(query);

  const auto resp = http_client_.CreateRequest()
                        .get(url)
                        .headers({{"Authorization", auth}})
                        .timeout(std::chrono::seconds{5})
                        .retry(2)
                        .perform();
  if (!resp->IsOk()) {
    throw std::runtime_error("Genius /search returned HTTP " +
                             std::to_string(resp->status_code()));
  }

  const auto json = formats::json::FromString(resp->body());
  const auto hits = json["response"]["hits"];

  std::vector<Candidate> candidates;
  std::unordered_set<std::int64_t> seen;
  const std::string q = NormalizeName(query);

  if (hits.IsArray()) {
    for (const auto &hit : hits) {
      const auto &p = hit["result"]["primary_artist"];
      const auto id = p["id"].As<std::int64_t>(0);
      if (id == 0 || seen.count(id))
        continue;
      seen.insert(id);

      Candidate c;
      c.id = id;
      c.name = p["name"].As<std::string>("");
      c.image = p["image_url"].As<std::string>("");
      c.url = p["url"].As<std::string>("");
      c.score = Similarity(q, NormalizeName(c.name));
      candidates.push_back(std::move(c));
    }
  }

  std::sort(
      candidates.begin(), candidates.end(),
      [](const Candidate &a, const Candidate &b) { return a.score > b.score; });
  if (candidates.size() > 8)
    candidates.resize(8);
  return candidates;
}

std::optional<ArtistRef> GraphHandler::FetchArtist(std::int64_t id) const {
  const std::string auth = "Bearer " + genius_token_;
  const std::string url = genius_base_url_ + "/artists/" + std::to_string(id);

  const auto resp = http_client_.CreateRequest()
                        .get(url)
                        .headers({{"Authorization", auth}})
                        .timeout(std::chrono::seconds{5})
                        .retry(2)
                        .perform();
  if (!resp->IsOk()) {
    LOG_WARNING() << "/artists/" << id << " returned HTTP "
                  << resp->status_code();
    return std::nullopt;
  }

  const auto json = formats::json::FromString(resp->body());
  const auto &a = json["response"]["artist"];
  if (!a.IsObject())
    return std::nullopt;

  ArtistRef r;
  r.id = a["id"].As<std::int64_t>(id);
  r.name = a["name"].As<std::string>("");
  r.image = a["image_url"].As<std::string>("");
  r.url = a["url"].As<std::string>("");
  return r;
}

std::string GraphHandler::BuildGraphForSeed(const ArtistRef &seed,
                                            const RoleMask &mask) const {
  const std::string auth = "Bearer " + genius_token_;
  const std::int64_t seed_id = seed.id;

  std::string songs_url =
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

  for (auto &pnd : pending) {
    try {
      auto detail = pnd.task.Get();
      {
        std::lock_guard lock(song_cache_mutex_);
        song_cache_[pnd.song_id] = detail;
      }
      if (detail)
        details.push_back(std::move(*detail));
    } catch (const std::exception &e) {
      LOG_WARNING() << "song-detail task failed (sid=" << pnd.song_id
                    << "): " << e.what();
    }
  }

  std::unordered_map<std::int64_t, std::string> names;
  std::unordered_map<std::int64_t, std::string> images;
  std::unordered_map<std::int64_t, std::string> urls;
  std::unordered_map<std::int64_t, EdgeAgg> edges_by_id;
  std::vector<std::int64_t> collaborator_order;
  names.reserve(details.size() * 4);
  images.reserve(details.size() * 4);
  urls.reserve(details.size() * 4);
  edges_by_id.reserve(details.size() * 4);
  collaborator_order.reserve(details.size() * 3);

  names[seed_id] = seed.name;
  if (!seed.image.empty())
    images[seed_id] = seed.image;
  if (!seed.url.empty())
    urls[seed_id] = seed.url;

  for (const auto &d : details) {
    std::unordered_map<std::int64_t, std::vector<std::string>> track_roles;
    std::unordered_map<std::int64_t, std::string> track_names;
    std::unordered_map<std::int64_t, std::string> track_images;
    std::unordered_map<std::int64_t, std::string> track_urls;
    track_roles.reserve(8);

    const auto note = [&](const ArtistRef &a, const char *role, bool allowed) {
      if (!allowed || a.id == 0)
        return;
      track_names[a.id] = a.name;
      if (!a.image.empty())
        track_images[a.id] = a.image;
      if (!a.url.empty())
        track_urls[a.id] = a.url;
      auto &roles = track_roles[a.id];
      if (std::find(roles.begin(), roles.end(), role) == roles.end())
        roles.emplace_back(role);
    };

    note(d.primary, "primary", mask.primary);
    for (const auto &a : d.producers)
      note(a, "producer", mask.producer);
    for (const auto &a : d.writers)
      note(a, "writer", mask.writer);
    for (const auto &a : d.featured)
      note(a, "featured", mask.featured);

    for (auto &[gid, roles] : track_roles) {
      if (gid == seed_id || roles.empty())
        continue;
      if (!names.count(gid))
        names[gid] = track_names[gid];
      if (!images.count(gid)) {
        const auto iit = track_images.find(gid);
        if (iit != track_images.end())
          images[gid] = iit->second;
      }
      if (!urls.count(gid)) {
        const auto uit = track_urls.find(gid);
        if (uit != track_urls.end())
          urls[gid] = uit->second;
      }

      // dominant role for this track / artist
      int track_rank = 0;
      for (const auto &r : roles)
        track_rank = std::max(track_rank, RoleRank(r));

      auto &agg = edges_by_id[gid];
      if (agg.weight == 0)
        collaborator_order.push_back(gid);
      ++agg.weight;
      if (track_rank > agg.best_rank) {
        agg.best_rank = track_rank;
        agg.role_priority = roles.empty() ? "featured" : [&] {
          // role name with the highest rank in this track
          std::string top = roles.front();
          int top_rank = RoleRank(top);
          for (const auto &r : roles) {
            const int rr = RoleRank(r);
            if (rr > top_rank) {
              top_rank = rr;
              top = r;
            }
          }
          return top;
        }();
      }
      agg.collaborations.push_back({d.title, std::move(roles)});
    }
  }

  // seed node weight = total collaboration weight across all edges
  int seed_weight = 0;
  for (const auto &gid : collaborator_order)
    seed_weight += edges_by_id[gid].weight;

  formats::json::ValueBuilder nodes_b(formats::json::Type::kArray);
  formats::json::ValueBuilder edges_b(formats::json::Type::kArray);

  const auto emit_node = [&](std::int64_t gid, int weight) {
    formats::json::ValueBuilder nb(formats::json::Type::kObject);
    nb["id"] = gid;
    const auto nit = names.find(gid);
    nb["label"] = nit != names.end() ? nit->second : std::string{};
    const auto iit = images.find(gid);
    if (iit != images.end() && !iit->second.empty())
      nb["image"] = iit->second;
    const auto uit = urls.find(gid);
    if (uit != urls.end() && !uit->second.empty())
      nb["url"] = uit->second;
    nb["weight"] = weight;
    nodes_b.PushBack(std::move(nb));
  };

  emit_node(seed_id, std::max(seed_weight, 1));

  for (const auto gid : collaborator_order) {
    const auto &agg = edges_by_id[gid];
    emit_node(gid, agg.weight);

    formats::json::ValueBuilder eb(formats::json::Type::kObject);
    eb["from"] = seed_id;
    eb["to"] = gid;
    eb["weight"] = agg.weight;
    eb["collaboration_count"] = agg.weight;
    eb["role_priority"] = agg.role_priority;

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
  graph["seed"] = seed.name;
  graph["seed_id"] = seed_id;
  if (!seed.url.empty())
    graph["seed_url"] = seed.url;
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
    match-threshold:
        type: number
        description: Min fuzzy similarity (0..1) to auto-load instead of disambiguating
        defaultDescription: '0.9'
)");
}

} // namespace six_feat
