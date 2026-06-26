// ════════════════════════════════════════════════════════════════════════════
// graph_handler.cpp  —  iteration 6
//
// Pure presentation layer.  Data acquisition is delegated to CollabService.
// Role utilities are imported from role_mask.hpp/cpp — no duplication.
//
// BuildGraphJson retains the full betweenness centrality logic and JSON
// assembly from iteration 4, but no longer contains ParseRoleMask,
// RoleAllowed, RoleRank, EdgeStyleForRole (all moved to role_mask.*).
// ════════════════════════════════════════════════════════════════════════════

#include "graph_handler.hpp"
#include "analytics.hpp"
#include "role_mask.hpp"

#include <algorithm>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

std::string EmptyGraph() {
    return R"({"type":"graph","seed":"","seed_id":0,"nodes":[],"edges":[]})";
}

std::string ErrorGraph(const std::string& msg) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["type"]  = std::string{"graph"};
    b["error"] = msg;
    b["nodes"] = formats::json::ValueBuilder(formats::json::Type::kArray);
    b["edges"] = formats::json::ValueBuilder(formats::json::Type::kArray);
    return formats::json::ToString(b.ExtractValue());
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Constructor
// ════════════════════════════════════════════════════════════════════════════

GraphHandler::GraphHandler(const components::ComponentConfig&  config,
                            const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      service_(context.FindComponent<CollabService>())
{}

// ════════════════════════════════════════════════════════════════════════════
// HandleRequestThrow
// ════════════════════════════════════════════════════════════════════════════

std::string GraphHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    auto& response = request.GetHttpResponse();
    response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    const RoleMask mask = ParseRoleMask(request.GetArg("roles"));

    // ── Resolve seed ─────────────────────────────────────────────────────────
    ArtistRef seed;
    const std::string& id_arg = request.GetArg("id");
    if (!id_arg.empty()) {
        std::int64_t id = 0;
        try { id = std::stoll(id_arg); } catch (...) {
            response.SetStatus(server::http::HttpStatus::kBadRequest);
            return ErrorGraph("'id' must be numeric");
        }
        const auto ref = service_.ResolveById(id);
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
            resolved = service_.ResolveByName(artist);
        } catch (const GeniusHttpError& e) {
            response.SetStatus(e.status_code == 503
                ? server::http::HttpStatus::kServiceUnavailable
                : server::http::HttpStatus::kBadGateway);
            return ErrorGraph("could not reach Genius");
        } catch (...) {
            response.SetStatus(server::http::HttpStatus::kBadGateway);
            return ErrorGraph("could not reach Genius");
        }

        if (std::holds_alternative<AmbiguousResult>(resolved)) {
            const auto& ar = std::get<AmbiguousResult>(resolved);
            if (ar.candidates.empty()) return EmptyGraph();
            // Return picker payload.
            formats::json::ValueBuilder out(formats::json::Type::kObject);
            out["type"]      = std::string{"graph"};
            out["ambiguous"] = true;
            out["query"]     = ar.query;
            formats::json::ValueBuilder arr(formats::json::Type::kArray);
            for (const auto& c : ar.candidates) {
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
        seed = std::get<ArtistRef>(resolved);
    }

    // ── Fetch data (FG + trigger BG) ─────────────────────────────────────────
    ArtistSongs data;
    try {
        data = service_.BuildRadialGraph(seed);
    } catch (const GeniusHttpError& e) {
        response.SetStatus(e.status_code == 503
            ? server::http::HttpStatus::kServiceUnavailable
            : server::http::HttpStatus::kBadGateway);
        return ErrorGraph("could not reach Genius");
    } catch (...) {
        response.SetStatus(server::http::HttpStatus::kBadGateway);
        return ErrorGraph("could not reach Genius");
    }

    return BuildGraphJson(data, mask);
}

// ════════════════════════════════════════════════════════════════════════════
// BuildGraphJson — presentation only (unchanged logic from iteration 4)
// ════════════════════════════════════════════════════════════════════════════

std::string GraphHandler::BuildGraphJson(const ArtistSongs& data,
                                          const RoleMask&    mask) const
{
    const std::int64_t seed_id = data.seed.id;

    struct EdgeAgg {
        int         weight{0};
        int         best_rank{0};
        std::string dominant_role{"featured"};
        std::string name, image, url;
        struct Collab {
            std::string              song;
            std::vector<std::string> roles;
        };
        std::vector<Collab>         collabs;
        // [BUG-6] Dedup set: tracks songs already in collabs to prevent
        // duplicate entries when the same artist appears with multiple roles
        // on the same track, or when artist credits are symmetric.
        std::unordered_set<std::string> seen_songs;
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
            // [BUG-6] Only count this song if we haven't seen it on this edge before.
            if (agg.seen_songs.insert(tc.song).second) {
                ++agg.weight;
            }
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

    // Build AdjList for Brandes BC.
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
        {
            formats::json::ValueBuilder eb(formats::json::Type::kObject);
            eb["from"]                = seed_id;
            eb["to"]                  = gid;
            eb["weight"]              = agg.weight;
            eb["collaboration_count"] = agg.weight;
            eb["dominant_role"]       = agg.dominant_role;
            eb["edge_style"]          = std::string{EdgeStyleForRole(agg.dominant_role)};
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
    graph["type"]    = std::string{"graph"};
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
description: Radial artist collaboration graph (iteration 6)
additionalProperties: false
properties: {}
)");
}

} // namespace six_feat
