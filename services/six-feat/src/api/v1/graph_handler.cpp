
#include "graph_handler.hpp"

#include "http/dto/artist_ref_dto.hpp"
#include "http/dto/candidate_dto.hpp"
#include "http/dto/graph_edge_dto.hpp"

#include "auth/api_key_auth.hpp"

#include "schemas/handlers/six-feat/graph_handler_schema.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <six-feat-auth-lib/user_identity.hpp>
#include <six-feat-common/music_source_provider.hpp>
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

std::string EmptyGraph(std::int64_t seed_id = 0, const std::string& seed_name = "") {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"graph"};
  b["seed"] = seed_name;
  b["seed_id"] = seed_id;
  b["nodes"] = formats::json::ValueBuilder(formats::json::Type::kArray);
  b["edges"] = formats::json::ValueBuilder(formats::json::Type::kArray);
  return formats::json::ToString(b.ExtractValue());
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

std::string AmbiguousGraphJson(const AmbiguousResult& ar) {
  formats::json::ValueBuilder out(formats::json::Type::kObject);
  out["type"] = std::string{"graph"};
  out["ambiguous"] = true;
  out["query"] = ar.query;
  formats::json::ValueBuilder arr(formats::json::Type::kArray);
  for (const auto& c : ar.candidates) {
    arr.PushBack(dto::ToJson(dto::ToDto(c)));
  }
  out["candidates"] = std::move(arr);
  return formats::json::ToString(out.ExtractValue());
}

std::string RateLimitKey(const server::http::HttpRequest& request, const auth::OAuthConfig& oauth) {
  std::string token = auth::ExtractToken(request, oauth.SessionKey());
  if (!token.empty()) return token;
  return request.GetRemoteAddress().PrimaryAddressString();
}

constexpr std::size_t kExpectedCollaboratorsPerSong = 3;

std::string NormalizedTitle(const std::string& title) {
  std::string out;
  out.reserve(title.size());
  bool last_was_space = true;
  for (unsigned char c : title) {
    if (std::isspace(c)) {
      if (!last_was_space) out.push_back(' ');
      last_was_space = true;
    } else {
      out.push_back(static_cast<char>(std::tolower(c)));
      last_was_space = false;
    }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

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
      api_key_store_(context.FindComponent<auth::ApiKeyStore>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()),
      rate_limit_("graph", 50, 1, context.FindComponent<RateLimitStoreComponent>().MakeStore()),
      max_limit_override_(config["max-limit-override"].As<int>(50)) {}

std::string GraphHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                             server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  std::string user_token;
  std::string limit_key;
  int rl_max = rate_limit_.Limit();
  std::chrono::seconds rl_window = rate_limit_.Window();

  const auto api_key_check = CheckApiKeyHeader(request, api_key_store_);
  if (api_key_check.provided) {
    if (!api_key_check.identity) {
      response.SetStatus(server::http::HttpStatus::kUnauthorized);
      return ErrorGraph("invalid_api_key");
    }
    const auto& identity = *api_key_check.identity;
    user_token = identity.genius_token;
    limit_key = "apikey:" + std::to_string(identity.id);
    const auto tier = ResolveRateTier(identity.rate_tier);
    rl_max = tier.max_per_window;
    rl_window = tier.window;
  } else {
    limit_key = RateLimitKey(request, oauth_);
  }

  if (!rate_limit_.AllowWithTier(limit_key, rl_max, rl_window)) {
    response.SetStatus(server::http::HttpStatus::kTooManyRequests);
    response.SetHeader(std::string{"Retry-After"}, std::string{"1"});
    response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rl_max));
    response.SetHeader(std::string{"X-RateLimit-Remaining"}, std::string{"0"});
    return ErrorGraph("rate limit exceeded");
  }
  response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rl_max));
  response.SetHeader(std::string{"X-RateLimit-Remaining"},
                     std::to_string(rate_limit_.RemainingWithTier(limit_key, rl_max, rl_window)));

  bool enrichment_enabled = true;

  // Валидная сессия обязательна ВСЕГДА (ТЗ-6), и проверяется она ДО разбора
  // параметров: иначе анонимный запрос без artist/id получал 400 «'artist'
  // or 'id' required» вместо 401 — то есть по коду ответа отличал «плохой
  // запрос» от «не залогинен», ещё не будучи никем.
  std::optional<auth::SessionData> session;
  if (user_token.empty()) {
    session = auth::RequireFullSession(request, oauth_);
    if (!session) {
      return ErrorGraph("not_authenticated");
    }
    enrichment_enabled = user_provider_tokens_.GetEnrichmentEnabled(auth::SessionUserId(*session));
  }

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

  const std::string& id_arg = request.GetArg("id");
  const std::string& artist_arg = request.GetArg("artist");
  if (id_arg.empty() && artist_arg.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorGraph("'artist' or 'id' required");
  }

  std::int64_t parsed_id = 0;
  if (!id_arg.empty()) {
    try {
      parsed_id = std::stoll(id_arg);
    } catch (...) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return ErrorGraph("'id' must be numeric");
    }
  }

  // [SF-YM-08] Сначала — сид из уже известного репозиторию, без единого
  // похода во внешний гейтвей: артист, уже известный кому-то раньше (чужой
  // Genius-поиск, фоновое обогащение), находится локально без токена.
  // Резолв СОВСЕМ нового имени/id по-прежнему требует Genius-токен (см.
  // ниже) — честный 422, а не тихий провал.
  ArtistRef seed;
  bool have_seed = false;
  if (!id_arg.empty()) {
    if (auto cached = service_.CachedSeed(parsed_id)) {
      seed = *cached;
      have_seed = true;
    }
  } else if (auto cached = service_.ResolveByNameFromCache(artist_arg)) {
    if (std::holds_alternative<AmbiguousResult>(*cached)) {
      return AmbiguousGraphJson(std::get<AmbiguousResult>(*cached));
    }
    seed = std::get<ArtistRef>(*cached);
    have_seed = true;
  }

  // Даже уже известный сид может потребовать сеть: limit override форсит
  // рефетч (см. BuildRadialGraph), Depth < Foreground — песни ещё не
  // подтянуты целиком.
  const bool seed_fully_cached = have_seed && !limit_override.has_value() &&
                                 service_.CachedDepth(seed.id) >= Depth::kForeground;

  // Сессия уже проверена выше; здесь остаётся только Genius-токен, и он
  // нужен лишь тогда, когда одного кэша не хватит.
  if (session && !seed_fully_cached) {
    const auto connected = user_provider_tokens_.Get(auth::SessionUserId(*session), "genius");
    user_token = auth::GeniusTokenForSession(*session, connected);
  }

  // [SF-YM-08] Резолв уже закэшированного сида не требует Genius-токена
  // (see выше) — но резолв СОВСЕМ нового id/имени требует, честный 422, не
  // тихий провал/пустой граф.
  if (!have_seed && user_token.empty()) {
    response.SetStatus(server::http::HttpStatus::kUnprocessableEntity);
    return ErrorGraph("no_genius_token");
  }

  if (!have_seed) {
    if (!id_arg.empty()) {
      std::optional<ArtistRef> ref;
      try {
        ref = service_.ResolveById(parsed_id, user_token);
      } catch (const GeniusHttpError& e) {
        return GeniusErrorGraph(e, response);
      } catch (...) {
        response.SetStatus(server::http::HttpStatus::kBadGateway);
        return ErrorGraph("could not reach Genius");
      }
      if (!ref) return EmptyGraph();
      seed = *ref;
    } else {
      std::variant<ArtistRef, AmbiguousResult> resolved;
      try {
        resolved = service_.ResolveByName(artist_arg, user_token);
      } catch (const GeniusHttpError& e) {
        return GeniusErrorGraph(e, response);
      } catch (...) {
        response.SetStatus(server::http::HttpStatus::kBadGateway);
        return ErrorGraph("could not reach Genius");
      }

      if (std::holds_alternative<AmbiguousResult>(resolved)) {
        const auto& ar = std::get<AmbiguousResult>(resolved);
        if (ar.candidates.empty()) return EmptyGraph();
        return AmbiguousGraphJson(ar);
      }
      seed = std::get<ArtistRef>(resolved);
    }
  }

  RadialGraphResult radial_result;
  try {
    radial_result =
        service_.BuildRadialGraphWithSource(seed, user_token, limit_override, enrichment_enabled);
  } catch (const GeniusHttpError& e) {
    return GeniusErrorGraph(e, response);
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return ErrorGraph("could not reach Genius");
  }

  const auto& data = radial_result.data;
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

  return BuildGraphJson(radial_result, mask, truncated, song_limit);
}

std::string GraphHandler::BuildGraphJson(const RadialGraphResult& result,
                                         const RoleMask& mask,
                                         bool truncated,
                                         int song_limit) const {
  const auto& data = result.data;
  const std::int64_t seed_id = data.seed.id;

  struct EdgeAgg {
    int weight{0};
    int best_rank{0};
    std::string dominant_role{"featured"};
    std::string name, image, url;
    struct Collab {
      std::string song;
      std::vector<std::string> roles;
      std::int64_t popularity{0};
    };
    std::vector<Collab> collabs;
    std::unordered_set<std::string> seen_titles;
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
      const bool is_new_song = agg.seen_titles.insert(NormalizedTitle(tc.song)).second;
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

  if (order.empty()) return EmptyGraph(seed_id, data.seed.name);

  AdjList adj;
  std::vector<std::int64_t> node_ids;
  node_ids.reserve(order.size() + 1);
  node_ids.push_back(seed_id);
  adj[seed_id];

  const auto source_for = [&result](std::int64_t x, std::int64_t y) {
    const auto lo = std::min(x, y);
    const auto hi = std::max(x, y);
    if (const auto oit = result.edge_sources.find(lo); oit != result.edge_sources.end()) {
      if (const auto iit = oit->second.find(hi); iit != oit->second.end()) return iit->second;
    }
    return EdgeSource::kGeniusCredit;
  };

  for (const auto gid : order) {
    const int w = edges.at(gid).weight;
    const auto src = source_for(seed_id, gid);
    adj[seed_id].push_back({gid, w, src});
    adj[gid].push_back({seed_id, w, src});
    node_ids.push_back(gid);
  }

  {
    for (const auto& song : data.songs) {
      const auto song_source = EdgeSource::kGeniusCredit;

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

          adj[a].push_back({b, 1, song_source});
          adj[b].push_back({a, 1, song_source});
        }
      }
    }

    LOG_DEBUG() << "[GraphHandler] ТЗ-Э: Added inter-collaborator edges, "
                << "graph now supports meaningful betweenness centrality";
  }

  for (auto& [node, neighbours] : adj) {
    std::unordered_map<std::int64_t, CollabEdge> merged;
    merged.reserve(neighbours.size());
    for (const auto& e : neighbours) {
      auto [it, inserted] = merged.try_emplace(e.neighbour, e);
      if (!inserted) {
        it->second.weight += e.weight;
        if (it->second.source != e.source) it->second.source = EdgeSource::kGeniusCredit;
      }
    }
    neighbours.clear();
    neighbours.reserve(merged.size());
    for (const auto& [nb, e] : merged) neighbours.push_back(e);
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
    auto nb = dto::ToJson(dto::ToDto(data.seed));
    nb["weight"] = seed_weight;
    const double raw = bc.count(seed_id) ? bc.at(seed_id) : 0.0;
    nb["betweenness"] = raw;
    nb["betweenness_normalised"] = (bc_max > 0.0) ? raw / bc_max : 0.0;
    nb["is_seed"] = true;

    nb["deepen_available"] = true;
    nodes_b.PushBack(std::move(nb));
  }

  for (const auto gid : order) {
    const auto& agg = edges.at(gid);
    {
      auto nb = dto::ToJson(dto::ToDto(ArtistRef{gid, agg.name, agg.image, agg.url}));
      nb["weight"] = agg.weight;
      const double raw = bc.count(gid) ? bc.at(gid) : 0.0;
      nb["betweenness"] = raw;
      nb["betweenness_normalised"] = (bc_max > 0.0) ? raw / bc_max : 0.0;
      nb["is_seed"] = false;
      nb["deepen_available"] = true;
      nodes_b.PushBack(std::move(nb));
    }
    {
      dto::GraphEdgeDto edge_dto;
      edge_dto.from = seed_id;
      edge_dto.to = gid;
      edge_dto.weight = agg.weight;
      edge_dto.collaboration_count = agg.weight;
      edge_dto.dominant_role = agg.dominant_role;
      edge_dto.edge_style = std::string{EdgeStyleForRole(agg.dominant_role)};

      edge_dto.source = ToString(source_for(seed_id, gid));

      edge_dto.collaborations.reserve(agg.collabs.size());
      for (const auto& c : agg.collabs) {
        edge_dto.collaborations.push_back({c.song, c.popularity, c.roles});
      }
      edges_b.PushBack(dto::ToJson(edge_dto));
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