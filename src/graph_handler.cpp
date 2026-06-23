// ════════════════════════════════════════════════════════════════════════════
// graph_handler.cpp  —  iteration 4
//
// GraphHandler delegates all I/O to GeniusClient.
// Its only responsibility: BuildGraphJson() — the presentation layer.
//
// New vs iteration 3:
//   • Imports analytics.hpp and calls BetweennessCentrality().
//   • Each node in the response carries "betweenness" and
//     "betweenness_normalised" fields.
//   • Response root gains "type":"graph" for unambiguous front-end dispatch.
// ════════════════════════════════════════════════════════════════════════════

#include "graph_handler.hpp"

#include <algorithm>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "analytics.hpp"
#include "genius_client.hpp"

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// File-private helpers
// ════════════════════════════════════════════════════════════════════════════

namespace {

std::string ToLower(std::string v) {
    std::transform(v.begin(), v.end(), v.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return v;
}

RoleMask ParseRoleMask(const std::string& spec) {
    if (spec.empty()) return RoleMask{};
    RoleMask m{false, false, false, false};
    std::size_t start = 0;
    while (start <= spec.size()) {
        const std::size_t comma = spec.find(',', start);
        const std::size_t len   = (comma == std::string::npos)
                                      ? std::string::npos : comma - start;
        const std::string tok   = ToLower(spec.substr(start, len));
        if      (tok == "primary")  m.primary  = true;
        else if (tok == "producer") m.producer = true;
        else if (tok == "writer")   m.writer   = true;
        else if (tok == "featured") m.featured = true;
        if (comma == std::string::npos) break;
        start = comma + 1;
    }
    return m;
}

bool RoleAllowed(const std::string& role, const RoleMask& mask) {
    if (role == "featured") return mask.featured;
    if (role == "producer") return mask.producer;
    if (role == "writer")   return mask.writer;
    if (role == "primary")  return mask.primary;
    return false;
}

int RoleRank(std::string_view role) {
    if (role == "producer") return 4;
    if (role == "writer")   return 3;
    if (role == "featured") return 2;
    if (role == "primary")  return 1;
    return 0;
}

std::string_view EdgeStyleForRole(std::string_view role) {
    if (role == "featured") return "solid";
    if (role == "producer") return "dashed";
    return "dotted";
}

std::string EmptyGraph() {
    return R"({"type":"graph","seed":"","seed_id":0,"nodes":[],"edges":[]})";
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Constructor
// ════════════════════════════════════════════════════════════════════════════

GraphHandler::GraphHandler(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      client_(context.FindComponent<GeniusClient>()) {}

// ════════════════════════════════════════════════════════════════════════════
// Request entry point
// ════════════════════════════════════════════════════════════════════════════

std::string GraphHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    auto& response = request.GetHttpResponse();
    response.SetContentType(
        http::ContentType{"application/json; charset=utf-8"});

    const RoleMask mask = ParseRoleMask(request.GetArg("roles"));

    // ── Resolve seed ─────────────────────────────────────────────────────
    ArtistRef seed;
    const std::string& id_arg = request.GetArg("id");
    if (!id_arg.empty()) {
        std::int64_t id = 0;
        try { id = std::stoll(id_arg); }
        catch (...) {
            response.SetStatus(server::http::HttpStatus::kBadRequest);
            return R"({"type":"graph","error":"'id' must be numeric","nodes":[],"edges":[]})";
        }
        auto fetched = client_.FetchArtistById(id);
        if (!fetched) return EmptyGraph();
        seed = std::move(*fetched);
    } else {
        const std::string& artist = request.GetArg("artist");
        if (artist.empty()) {
            response.SetStatus(server::http::HttpStatus::kBadRequest);
            return R"({"type":"graph","error":"'artist' or 'id' required","nodes":[],"edges":[]})";
        }

        std::vector<Candidate> candidates;
        try {
            candidates = client_.ResolveCandidates(artist);
        } catch (const GeniusHttpError& e) {
            response.SetStatus(e.status_code == 503
                ? server::http::HttpStatus::kServiceUnavailable
                : server::http::HttpStatus::kBadGateway);
            return R"({"type":"graph","error":"could not reach Genius","nodes":[],"edges":[]})";
        } catch (...) {
            response.SetStatus(server::http::HttpStatus::kBadGateway);
            return R"({"type":"graph","error":"could not reach Genius","nodes":[],"edges":[]})";
        }

        if (candidates.empty()) return EmptyGraph();

        const Candidate& best = candidates.front();
        if (best.score < client_.MatchThreshold()) {
            // Ambiguous — return picker payload (unchanged from iteration 3).
            formats::json::ValueBuilder out(formats::json::Type::kObject);
            out["type"]      = std::string{"graph"};
            out["ambiguous"] = true;
            out["query"]     = artist;
            formats::json::ValueBuilder arr(formats::json::Type::kArray);
            const std::size_t limit = std::min<std::size_t>(candidates.size(), 6);
            for (std::size_t i = 0; i < limit; ++i) {
                const auto& c = candidates[i];
                formats::json::ValueBuilder cb(formats::json::Type::kObject);
                cb["id"]    = c.id;
                cb["name"]  = c.name;
                if (!c.image.empty()) cb["image"] = c.image;
                if (!c.url.empty())   cb["url"]   = c.url;
                cb["score"] = c.score;
                arr.PushBack(std::move(cb));
            }
            out["candidates"] = std::move(arr);
            return formats::json::ToString(out.ExtractValue());
        }
        seed = {best.id, best.name, best.image, best.url};
    }

    // ── Data layer ───────────────────────────────────────────────────────
    ArtistSongs data;
    try {
        data = client_.GetOrFetchArtistSongs(seed);
    } catch (const GeniusHttpError& e) {
        response.SetStatus(e.status_code == 503
            ? server::http::HttpStatus::kServiceUnavailable
            : server::http::HttpStatus::kBadGateway);
        return R"({"type":"graph","error":"could not reach Genius","nodes":[],"edges":[]})";
    } catch (...) {
        response.SetStatus(server::http::HttpStatus::kBadGateway);
        return R"({"type":"graph","error":"could not reach Genius","nodes":[],"edges":[]})";
    }

    return BuildGraphJson(data, mask);
}

// ════════════════════════════════════════════════════════════════════════════
// BuildGraphJson — presentation layer + analytics
// ════════════════════════════════════════════════════════════════════════════

std::string GraphHandler::BuildGraphJson(
    const ArtistSongs& data,
    const RoleMask&    mask) const
{
    const std::int64_t seed_id = data.seed.id;

    // ── Aggregate edges ──────────────────────────────────────────────────

    struct EdgeAgg {
        int         weight{0};
        int         best_rank{0};
        std::string dominant_role{"featured"};
        std::string name, image, url;
        struct Collab { std::string song; std::vector<std::string> roles; };
        std::vector<Collab> collabs;
    };

    std::unordered_map<std::int64_t, EdgeAgg> edges;
    std::vector<std::int64_t>                 order;
    edges.reserve(data.songs.size() * 3);
    order.reserve(data.songs.size() * 3);

    for (const auto& song : data.songs) {
        std::unordered_map<std::int64_t, EdgeAgg::Collab> track;
        track.reserve(8);

        for (const auto& credit : song.credits) {
            if (credit.artist.id == seed_id)    continue;
            if (!RoleAllowed(credit.role, mask)) continue;
            auto& tc = track[credit.artist.id];
            if (tc.song.empty()) {
                tc.song = song.title;
                auto& agg = edges[credit.artist.id];
                if (agg.name.empty()) {
                    agg.name  = credit.artist.name;
                    agg.image = credit.artist.image;
                    agg.url   = credit.artist.url;
                    order.push_back(credit.artist.id);
                }
            }
            auto& roles = tc.roles;
            if (std::find(roles.begin(), roles.end(), credit.role) == roles.end())
                roles.push_back(credit.role);
        }

        for (auto& [gid, tc] : track) {
            auto& agg = edges[gid];
            ++agg.weight;
            int tr = 0;
            for (const auto& r : tc.roles) tr = std::max(tr, RoleRank(r));
            if (tr > agg.best_rank) {
                agg.best_rank = tr;
                std::string top; int top_r = -1;
                for (const auto& r : tc.roles) {
                    const int rr = RoleRank(r);
                    if (rr > top_r) { top_r = rr; top = r; }
                }
                agg.dominant_role = std::move(top);
            }
            agg.collabs.push_back(std::move(tc));
        }
    }

    if (order.empty()) return EmptyGraph();

    // ── Build AdjList for Betweenness Centrality ─────────────────────────
    //
    // The graph is star-shaped: seed ↔ each collaborator.
    // In a pure star graph all BC is concentrated on the seed node (it lies
    // on every shortest path between pairs of leaf nodes).  That's correct
    // and informative: the seed is the bridge between all collaborators.
    // After expansion (double-click on a node) the graph becomes multi-hop
    // and BC meaningfully identifies cross-genre bridges.

    AdjList adj;
    std::vector<std::int64_t> node_ids;
    node_ids.reserve(order.size() + 1);
    node_ids.push_back(seed_id);
    adj[seed_id]; // ensure seed has an entry even if isolated (shouldn't happen)

    for (const auto gid : order) {
        const int w = edges.at(gid).weight;
        adj[seed_id].push_back({gid, w});
        adj[gid].push_back({seed_id, w});
        node_ids.push_back(gid);
    }

    // ── Compute Betweenness Centrality ───────────────────────────────────
    const auto bc = BetweennessCentrality(adj, node_ids);

    double bc_max = 0.0;
    for (const auto& [id, score] : bc) bc_max = std::max(bc_max, score);

    // ── Compute seed weight ──────────────────────────────────────────────
    const int seed_weight = [&] {
        int w = 0;
        for (const auto id : order) w += edges.at(id).weight;
        return std::max(w, 1);
    }();

    // ── JSON assembly ─────────────────────────────────────────────────────
    formats::json::ValueBuilder nodes_b(formats::json::Type::kArray);
    formats::json::ValueBuilder edges_b(formats::json::Type::kArray);

    // Seed node.
    {
        formats::json::ValueBuilder nb(formats::json::Type::kObject);
        nb["id"]     = seed_id;
        nb["label"]  = data.seed.name;
        nb["weight"] = seed_weight;
        if (!data.seed.image.empty()) nb["image"] = data.seed.image;
        if (!data.seed.url.empty())   nb["url"]   = data.seed.url;
        const double raw = bc.count(seed_id) ? bc.at(seed_id) : 0.0;
        nb["betweenness"]            = raw;
        nb["betweenness_normalised"] = (bc_max > 0.0) ? raw / bc_max : 0.0;
        nb["is_seed"] = true;
        nodes_b.PushBack(std::move(nb));
    }

    for (const auto gid : order) {
        const auto& agg = edges.at(gid);

        // Collaborator node.
        {
            formats::json::ValueBuilder nb(formats::json::Type::kObject);
            nb["id"]     = gid;
            nb["label"]  = agg.name;
            nb["weight"] = agg.weight;
            if (!agg.image.empty()) nb["image"] = agg.image;
            if (!agg.url.empty())   nb["url"]   = agg.url;
            const double raw = bc.count(gid) ? bc.at(gid) : 0.0;
            nb["betweenness"]            = raw;
            nb["betweenness_normalised"] = (bc_max > 0.0) ? raw / bc_max : 0.0;
            nb["is_seed"] = false;
            nodes_b.PushBack(std::move(nb));
        }

        // Edge.
        {
            formats::json::ValueBuilder eb(formats::json::Type::kObject);
            eb["from"]                = seed_id;
            eb["to"]                  = gid;
            eb["weight"]              = agg.weight;
            eb["collaboration_count"] = agg.weight;
            eb["dominant_role"]       = agg.dominant_role;
            eb["edge_style"]          =
                std::string{EdgeStyleForRole(agg.dominant_role)};

            formats::json::ValueBuilder cb(formats::json::Type::kArray);
            for (const auto& c : agg.collabs) {
                formats::json::ValueBuilder ci(formats::json::Type::kObject);
                ci["song"] = c.song;
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
    graph["type"]    = std::string{"graph"};   // NEW: response type discriminator
    graph["seed"]    = data.seed.name;
    graph["seed_id"] = seed_id;
    if (!data.seed.url.empty()) graph["seed_url"] = data.seed.url;
    graph["nodes"]   = std::move(nodes_b);
    graph["edges"]   = std::move(edges_b);
    return formats::json::ToString(graph.ExtractValue());
}

// ════════════════════════════════════════════════════════════════════════════
// Schema
// ════════════════════════════════════════════════════════════════════════════

yaml_config::Schema GraphHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(R"(
type: object
description: Radial artist collaboration graph
additionalProperties: false
properties: {}
)");
}

} // namespace six_feat