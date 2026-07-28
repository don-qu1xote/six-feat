
#include "http/graph_handler.hpp"

#include "schemas/handlers/six-feat/graph_handler_schema.hpp"

#include <algorithm>
#include <six-feat-core/http_cache.hpp>
#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-domain/role_mask.hpp>
#include <six-feat-storage/analytics.hpp>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <variant>
#include <vector>

#include "infrastructure/genius_error_mapping.hpp"

namespace six_feat {

using namespace userver;

namespace {

std::string EmptyGraph() {
  return R"({"type":"graph","seed":"","seed_id":0,"nodes":[],"edges":[]})";
}

std::string ErrorGraph(const std::string& msg) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"graph"};
  b["error"] = msg;
  b["request_id"] = CurrentRequestId();
  b["nodes"] = formats::json::ValueBuilder(formats::json::Type::kArray);
  b["edges"] = formats::json::ValueBuilder(formats::json::Type::kArray);
  return formats::json::ToString(b.ExtractValue());
}

std::string GeniusErrorGraph(const GeniusHttpError& e, server::http::HttpResponse& response) {
  const std::string code = MapGeniusHttpError(e, response);
  if (code == "token_invalid") return ErrorGraph("token_invalid");
  if (code == "client_cancelled") return ErrorGraph("client request cancelled");
  return ErrorGraph("could not reach Genius");
}

std::string RateLimitKey(const server::http::HttpRequest& request, const auth::OAuthConfig& oauth) {
  std::string token = auth::ExtractToken(request, oauth.SessionKey());
  if (!token.empty()) return token;
  return request.GetRemoteAddress().PrimaryAddressString();
}

constexpr std::size_t kExpectedCollaboratorsPerSong = 3;

std::string BuildGraphETag(std::int64_t seed_id,
                           const FetchState& fs,
                           const RoleMask& mask,
                           bool truncated,
                           int song_limit) {
  const int mask_bits = (mask.primary ? 1 : 0) | (mask.producer ? 2 : 0) | (mask.writer ? 4 : 0) |
                        (mask.featured ? 8 : 0);
  return "W/\"" + std::to_string(seed_id) + "-" + std::to_string(static_cast<int>(fs.depth)) + "-" +
         std::to_string(fs.song_count) + "-" + std::to_string(mask_bits) + "-" +
         (truncated ? "1" : "0") + "-" + std::to_string(song_limit) + "\"";
}

}  // namespace

GraphHandler::GraphHandler(const components::ComponentConfig& config,
                           const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      service_(context.FindComponent<CollabService>()),
      store_(context.FindComponent<PersistentStore>()),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      rate_limit_("graph", 50, 1, context.FindComponent<RateLimitStoreComponent>().MakeStore()),
      max_limit_override_(config["max-limit-override"].As<int>(50)) {}

std::string GraphHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                             server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const std::string limit_key = RateLimitKey(request, oauth_);
  if (!rate_limit_.Allow(limit_key)) {
    response.SetStatus(server::http::HttpStatus::kTooManyRequests);
    response.SetHeader(std::string{"Retry-After"}, std::string{"1"});
    response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rate_limit_.Limit()));
    response.SetHeader(std::string{"X-RateLimit-Remaining"}, std::string{"0"});
    return ErrorGraph("rate limit exceeded");
  }
  response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rate_limit_.Limit()));
  response.SetHeader(std::string{"X-RateLimit-Remaining"},
                     std::to_string(rate_limit_.Remaining(limit_key)));

  const auto token = Prologue(request);
  if (!token) {
    return ErrorGraph("not_authenticated");
  }
  const std::string& user_token = *token;

  const RoleMask mask = ParseRoleMask(request.GetArg("roles"));

  std::optional<int> limit_override;
  const std::string& limit_arg = request.GetArg("limit");
  if (!limit_arg.empty()) {
    int parsed = 0;
    try {
      parsed = std::stoi(limit_arg);
    } catch (...) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return ErrorGraph("'limit' must be numeric");
    }
    if (parsed <= 0 || parsed > max_limit_override_) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return ErrorGraph("'limit' must be between 1 and " + std::to_string(max_limit_override_));
    }
    limit_override = parsed;
  }

  ArtistRef seed;
  const std::string& id_arg = request.GetArg("id");
  if (!id_arg.empty()) {
    std::int64_t id = 0;
    try {
      id = std::stoll(id_arg);
    } catch (...) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return ErrorGraph("'id' must be numeric");
    }
    std::optional<ArtistRef> ref;
    try {
      ref = service_.ResolveById(id, user_token);
    } catch (const GeniusHttpError& e) {
      return GeniusErrorGraph(e, response);
    } catch (...) {
      response.SetStatus(server::http::HttpStatus::kBadGateway);
      return ErrorGraph("could not reach Genius");
    }
    if (!ref) return EmptyGraph();
    seed = *ref;
  } else {
    const std::string& artist = request.GetArg("artist");
    if (artist.empty()) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return ErrorGraph("'artist' or 'id' required");
    }

    std::variant<ArtistRef, AmbiguousResult> resolved;
    try {
      resolved = service_.ResolveByName(artist, user_token);
    } catch (const GeniusHttpError& e) {
      return GeniusErrorGraph(e, response);
    } catch (...) {
      response.SetStatus(server::http::HttpStatus::kBadGateway);
      return ErrorGraph("could not reach Genius");
    }

    if (std::holds_alternative<AmbiguousResult>(resolved)) {
      const auto& ar = std::get<AmbiguousResult>(resolved);
      if (ar.candidates.empty()) return EmptyGraph();
      formats::json::ValueBuilder out(formats::json::Type::kObject);
      out["type"] = std::string{"graph"};
      out["ambiguous"] = true;
      out["query"] = ar.query;
      formats::json::ValueBuilder arr(formats::json::Type::kArray);
      for (const auto& c : ar.candidates) {
        formats::json::ValueBuilder cb(formats::json::Type::kObject);
        cb["id"] = c.id;
        cb["name"] = c.name;
        if (!c.image.empty()) cb["image"] = c.image;
        if (!c.url.empty()) cb["url"] = c.url;
        cb["score"] = c.score;
        arr.PushBack(std::move(cb));
      }
      out["candidates"] = std::move(arr);
      return formats::json::ToString(out.ExtractValue());
    }
    seed = std::get<ArtistRef>(resolved);
  }

  ArtistSongs data;
  try {
    data = service_.BuildRadialGraph(seed, user_token, limit_override);
  } catch (const GeniusHttpError& e) {
    return GeniusErrorGraph(e, response);
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return ErrorGraph("could not reach Genius");
  }

  const int song_limit = limit_override.value_or(service_.SongsLimitFg());
  const bool truncated = static_cast<int>(data.songs.size()) >= song_limit;

  const FetchState fetch_state = store_.GetFetchState(seed.id);
  const std::string etag = BuildGraphETag(seed.id, fetch_state, mask, truncated, song_limit);
  response.SetHeader(std::string{"ETag"}, etag);
  response.SetHeader(std::string{"Cache-Control"}, std::string{"private, must-revalidate"});

  const std::string& if_none_match = request.GetHeader(std::string_view{"If-None-Match"});
  if (ETagMatches(if_none_match, etag)) {
    response.SetStatus(server::http::HttpStatus::kNotModified);
    return {};
  }

  return BuildGraphJson(data, mask, truncated, song_limit);
}

std::string GraphHandler::BuildGraphJson(const ArtistSongs& data,
                                         const RoleMask& mask,
                                         bool truncated,
                                         int song_limit) const {
  const std::int64_t seed_id = data.seed.id;

  struct EdgeAgg {
    int weight{0};
    int best_rank{0};
    std::string dominant_role{"featured"};
    std::string name, image, url;
    struct Collab {
      std::int64_t song_id{0};
      std::string song;
      std::vector<std::string> roles;
      std::int64_t popularity{0};
    };
    std::vector<Collab> collabs;
    std::unordered_set<std::int64_t> seen_songs;
  };

  std::unordered_map<std::int64_t, EdgeAgg> edges;
  std::vector<std::int64_t> order;
  edges.reserve(data.songs.size() * kExpectedCollaboratorsPerSong);
  order.reserve(data.songs.size() * kExpectedCollaboratorsPerSong);

  for (const auto& song : data.songs) {
    std::unordered_map<std::int64_t, EdgeAgg::Collab> track;
    track.reserve(8);
    for (const auto& credit : song.credits) {
      if (credit.artist.id == seed_id) continue;
      if (!RoleAllowed(credit.role, mask)) continue;
      auto& tc = track[credit.artist.id];
      if (tc.song.empty()) {
        tc.song = song.title;
        tc.song_id = song.id;
        tc.popularity = song.popularity;
        auto& agg = edges[credit.artist.id];
        if (agg.name.empty()) {
          agg.name = credit.artist.name;
          agg.image = credit.artist.image;
          agg.url = credit.artist.url;
          order.push_back(credit.artist.id);
        }
      }
      auto& roles = tc.roles;
      if (std::find(roles.begin(), roles.end(), credit.role) == roles.end())
        roles.push_back(credit.role);
    }
    for (auto& [gid, tc] : track) {
      auto& agg = edges[gid];
      const bool is_new_song = agg.seen_songs.insert(tc.song_id).second;
      if (is_new_song) {
        ++agg.weight;
      }
      int tr = 0;
      for (const auto& r : tc.roles) tr = std::max(tr, RoleRank(r));
      if (tr > agg.best_rank) {
        agg.best_rank = tr;
        std::string top;
        int top_r = -1;
        for (const auto& r : tc.roles) {
          const int rr = RoleRank(r);
          if (rr > top_r) {
            top_r = rr;
            top = r;
          }
        }
        agg.dominant_role = std::move(top);
      }
      if (is_new_song) {
        agg.collabs.push_back(std::move(tc));
      }
    }
  }

  if (order.empty()) return EmptyGraph();

  AdjList adj;
  std::vector<std::int64_t> node_ids;
  node_ids.reserve(order.size() + 1);
  node_ids.push_back(seed_id);
  adj[seed_id];

  for (const auto gid : order) {
    const int w = edges.at(gid).weight;
    adj[seed_id].push_back({gid, w});
    adj[gid].push_back({seed_id, w});
    node_ids.push_back(gid);
  }

  {
    for (const auto& song : data.songs) {
      std::vector<std::int64_t> collabs_in_song;
      collabs_in_song.reserve(song.credits.size());

      for (const auto& credit : song.credits) {
        if (credit.artist.id == seed_id) continue;
        if (!RoleAllowed(credit.role, mask)) continue;

        if (edges.count(credit.artist.id)) {
          collabs_in_song.push_back(credit.artist.id);
        }
      }

      for (size_t i = 0; i < collabs_in_song.size(); i++) {
        for (size_t j = i + 1; j < collabs_in_song.size(); j++) {
          auto a = collabs_in_song[i];
          auto b = collabs_in_song[j];

          adj[a].push_back({b, 1});
          adj[b].push_back({a, 1});
        }
      }
    }

    LOG_DEBUG() << "[GraphHandler] ТЗ-Э: Added inter-collaborator edges, "
                << "graph now supports meaningful betweenness centrality";
  }

  for (auto& [node, neighbours] : adj) {
    std::unordered_map<std::int64_t, int> merged;
    merged.reserve(neighbours.size());
    for (const auto& e : neighbours) merged[e.neighbour] += e.weight;
    neighbours.clear();
    neighbours.reserve(merged.size());
    for (const auto& [nb, w] : merged) neighbours.push_back({nb, w});
  }

  const auto bc = BetweennessCentrality(adj, node_ids);
  double bc_max = 0.0;
  for (const auto& [id, score] : bc) bc_max = std::max(bc_max, score);

  const int seed_weight = [&] {
    int w = 0;
    for (const auto id : order) w += edges.at(id).weight;
    return std::max(w, 1);
  }();

  formats::json::ValueBuilder nodes_b(formats::json::Type::kArray);
  formats::json::ValueBuilder edges_b(formats::json::Type::kArray);

  {
    formats::json::ValueBuilder nb(formats::json::Type::kObject);
    nb["id"] = seed_id;
    nb["name"] = data.seed.name;
    nb["weight"] = seed_weight;
    if (!data.seed.image.empty()) nb["image"] = data.seed.image;
    if (!data.seed.url.empty()) nb["url"] = data.seed.url;
    const double raw = bc.count(seed_id) ? bc.at(seed_id) : 0.0;
    nb["betweenness"] = raw;
    nb["betweenness_normalised"] = (bc_max > 0.0) ? raw / bc_max : 0.0;
    nb["is_seed"] = true;
    nodes_b.PushBack(std::move(nb));
  }

  for (const auto gid : order) {
    const auto& agg = edges.at(gid);
    {
      formats::json::ValueBuilder nb(formats::json::Type::kObject);
      nb["id"] = gid;
      nb["name"] = agg.name;
      nb["weight"] = agg.weight;
      if (!agg.image.empty()) nb["image"] = agg.image;
      if (!agg.url.empty()) nb["url"] = agg.url;
      const double raw = bc.count(gid) ? bc.at(gid) : 0.0;
      nb["betweenness"] = raw;
      nb["betweenness_normalised"] = (bc_max > 0.0) ? raw / bc_max : 0.0;
      nb["is_seed"] = false;
      nodes_b.PushBack(std::move(nb));
    }
    {
      formats::json::ValueBuilder eb(formats::json::Type::kObject);
      eb["from"] = seed_id;
      eb["to"] = gid;
      eb["weight"] = agg.weight;
      eb["collaboration_count"] = agg.weight;
      eb["dominant_role"] = agg.dominant_role;
      eb["edge_style"] = std::string{EdgeStyleForRole(agg.dominant_role)};
      formats::json::ValueBuilder cb(formats::json::Type::kArray);
      for (const auto& c : agg.collabs) {
        formats::json::ValueBuilder ci(formats::json::Type::kObject);
        ci["song"] = c.song;
        ci["popularity"] = c.popularity;
        formats::json::ValueBuilder rb(formats::json::Type::kArray);
        for (const auto& r : c.roles) rb.PushBack(r);
        ci["roles"] = std::move(rb);
        cb.PushBack(std::move(ci));
      }
      eb["collaborations"] = std::move(cb);
      edges_b.PushBack(std::move(eb));
    }
  }

  formats::json::ValueBuilder graph(formats::json::Type::kObject);
  graph["type"] = std::string{"graph"};
  graph["seed"] = data.seed.name;
  graph["seed_id"] = seed_id;
  if (!data.seed.url.empty()) graph["seed_url"] = data.seed.url;
  graph["nodes"] = std::move(nodes_b);
  graph["edges"] = std::move(edges_b);
  graph["truncated"] = truncated;
  graph["shown_song_count"] = static_cast<std::int64_t>(data.songs.size());
  graph["song_limit"] = song_limit;
  return formats::json::ToString(graph.ExtractValue());
}

yaml_config::Schema GraphHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGraphHandlerSchema);
}

}  // namespace six_feat