#include "challenge_handler.hpp"

#include "game_session.hpp"
#include "game_store.hpp"
#include "ideal_finder.hpp"
#include "neighbours_client.hpp"
#include "auth/session_crypto.hpp"
#include "core/error_response.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/handlers/game/challenge_handler_schema.hpp"

#include <cstdint>
#include <optional>
#include <string>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::game {

using namespace userver;

namespace {

// Same convention artist_handler.hpp's "image"/"url" fields use: an
// unset/unknown value is OMITTED from the body, never emitted as null.
std::string ChallengeJson(std::int64_t id, std::int64_t from, std::int64_t to,
                          int role_mask, const std::string& kind,
                          const std::optional<int>& optimal_len) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["id"]        = id;
    b["from"]      = from;
    b["to"]        = to;
    b["role_mask"] = role_mask;
    b["kind"]      = kind;
    if (optimal_len) b["optimal_len"] = *optimal_len;
    return formats::json::ToString(b.ExtractValue());
}

} // namespace

ChallengeHandler::ChallengeHandler(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , store_(context.FindComponent<GameStore>())
    , neighbours_(context.FindComponent<NeighboursClient>())
    , session_key_(auth::KeyFromEnv())
{}

std::string ChallengeHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    auto& response = request.GetHttpResponse();
    response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    // ── GET /api/v1/game/challenge?id=<id> — open, no session required ──────
    if (request.GetMethod() == server::http::HttpMethod::kGet) {
        const auto& id_str = request.GetArg("id");
        if (id_str.empty()) {
            response.SetStatus(server::http::HttpStatus::kBadRequest);
            return BuildProblemJson(request, server::http::HttpStatus::kBadRequest,
                                    "missing ?id=<challenge_id>");
        }
        std::int64_t challenge_id = 0;
        try {
            std::size_t pos = 0;
            challenge_id = std::stoll(id_str, &pos);
            if (pos != id_str.size()) throw std::invalid_argument("trailing garbage");
        } catch (const std::exception&) {
            response.SetStatus(server::http::HttpStatus::kBadRequest);
            return BuildProblemJson(request, server::http::HttpStatus::kBadRequest,
                                    "id must be an integer");
        }

        const auto challenge = store_.GetChallenge(challenge_id);
        if (!challenge) {
            response.SetStatus(server::http::HttpStatus::kNotFound);
            return BuildProblemJson(request, server::http::HttpStatus::kNotFound,
                                    "no such challenge");
        }
        return ChallengeJson(challenge->id, challenge->from_artist_id,
                             challenge->to_artist_id, challenge->role_mask,
                             challenge->kind, challenge->optimal_len);
    }

    // ── POST /api/v1/game/challenge — session required ──────────────────────
    const auto player = ResolvePlayer(request, session_key_);
    if (!player) {
        response.SetStatus(server::http::HttpStatus::kUnauthorized);
        return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized,
                                "not authenticated");
    }

    std::int64_t from = 0, to = 0;
    int          role_mask = 0;
    try {
        const auto body = formats::json::FromString(request.RequestBody());
        from      = body["from"].As<std::int64_t>(0);
        to        = body["to"].As<std::int64_t>(0);
        role_mask = body["role_mask"].As<int>(15);
    } catch (const std::exception&) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(
            request, server::http::HttpStatus::kBadRequest,
            "body must be JSON with from and to (int64)");
    }

    if (from <= 0 || to <= 0 || from == to) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(
            request, server::http::HttpStatus::kBadRequest,
            "from and to are required, must be positive, and must differ");
    }
    if (role_mask <= 0) role_mask = 15;

    auto challenge = store_.UpsertChallenge(from, to, role_mask, "custom", player->user_id);

    // Lazy: the (rare, once-per-distinct-pair) BFS cost is paid by whichever
    // create/get call is first to see a still-null optimal_len, not up front.
    if (!challenge.optimal_len) {
        const auto path = FindIdealPath(neighbours_, from, to, role_mask);
        if (path) {
            const int optimal_len = static_cast<int>(path->size()) - 1;
            if (store_.SetChallengeIdeal(challenge.id, optimal_len, *path)) {
                challenge.optimal_len = optimal_len;
            }
        }
        // Not found: leave optimal_len unset — L1 doesn't connect this pair
        // (yet); a later create/get call on the same pair will retry.
    }

    return ChallengeJson(challenge.id, from, to, role_mask, "custom", challenge.optimal_len);
}

yaml_config::Schema ChallengeHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
        kGameChallengeHandlerSchema);
}

} // namespace six_feat::game
