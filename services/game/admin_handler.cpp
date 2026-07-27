#include "admin_handler.hpp"

#include "game_session.hpp"
#include "game_store.hpp"
#include "ideal_finder.hpp"
#include "neighbours_client.hpp"
#include "auth/session_crypto.hpp"
#include "core/error_response.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/handlers/game/admin_handler_schema.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <string>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_method.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/utils/rand.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::game {

using namespace userver;

namespace {

// Same "all four roles" convention DailyChallengeTask uses — a published daily
// isn't answering any specific request's role filter.
constexpr int kAllRolesMask = 15;

std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

std::string Trim(const std::string& s) {
    const auto b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    const auto e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// Split a comma-separated allowlist into trimmed, lowercased, non-empty entries.
std::vector<std::string> ParseAdminIds(const std::string& raw) {
    std::vector<std::string> out;
    std::size_t start = 0;
    while (start <= raw.size()) {
        const auto comma = raw.find(',', start);
        const auto token = Trim(raw.substr(start, comma == std::string::npos
                                                       ? std::string::npos
                                                       : comma - start));
        if (!token.empty()) out.push_back(ToLower(token));
        if (comma == std::string::npos) break;
        start = comma + 1;
    }
    return out;
}

// id/from/to/role_mask are distinct fields named at every call site (never
// positionally reordered); swapping them is not a realistic mistake.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
std::string DailyPublishedJson(std::int64_t id, std::int64_t from, std::int64_t to,
                               int role_mask, const std::optional<int>& optimal_len) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["id"]        = id;
    b["from"]      = from;
    b["to"]        = to;
    b["role_mask"] = role_mask;
    b["kind"]      = "daily";
    if (optimal_len) b["optimal_len"] = *optimal_len;
    return formats::json::ToString(b.ExtractValue());
}

} // namespace

AdminHandler::AdminHandler(const components::ComponentConfig&  config,
                           const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , store_(context.FindComponent<GameStore>())
    , neighbours_(context.FindComponent<NeighboursClient>())
    , session_key_(auth::KeyFromEnv())
    , admin_ids_(ParseAdminIds(config["admin-user-ids"].As<std::string>("")))
{}

bool AdminHandler::IsAdmin(const Player& player) const {
    if (admin_ids_.empty()) return false;  // no allowlist → nobody is admin
    const std::string name_lc = ToLower(player.name);
    const std::string id_str  = std::to_string(player.user_id);
    for (const auto& entry : admin_ids_) {
        if (entry == name_lc || entry == id_str) return true;
    }
    return false;
}

std::string AdminHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    auto& response = request.GetHttpResponse();
    response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    const auto player = ResolvePlayer(request, session_key_);

    // ── GET — UI-gating status probe (signed-out is simply not-admin) ────────
    if (request.GetMethod() == server::http::HttpMethod::kGet) {
        formats::json::ValueBuilder b(formats::json::Type::kObject);
        b["admin"] = player && IsAdmin(*player);
        return formats::json::ToString(b.ExtractValue());
    }

    // ── POST — publish a daily challenge now (owner only) ────────────────────
    if (!player) {
        response.SetStatus(server::http::HttpStatus::kUnauthorized);
        return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized,
                                "not authenticated");
    }
    if (!IsAdmin(*player)) {
        response.SetStatus(server::http::HttpStatus::kForbidden);
        return BuildProblemJson(request, server::http::HttpStatus::kForbidden,
                                "not an admin");
    }

    std::int64_t from = 0, to = 0;
    try {
        // An empty body is fine — both endpoints default to 0 → random pair.
        const auto& raw = request.RequestBody();
        if (!raw.empty()) {
            const auto body = formats::json::FromString(raw);
            from = body["from"].As<std::int64_t>(0);
            to   = body["to"].As<std::int64_t>(0);
        }
    } catch (const std::exception&) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(request, server::http::HttpStatus::kBadRequest,
                                "body, if present, must be JSON with from/to (int64)");
    }

    // No pair supplied → draw a random one from the same candidate pool the
    // once-a-day task uses.
    if (from <= 0 || to <= 0) {
        const auto candidates = store_.RandomArtistIdsWithCredits(50);
        if (candidates.size() < 2) {
            response.SetStatus(server::http::HttpStatus::kUnprocessableEntity);
            return BuildProblemJson(request, server::http::HttpStatus::kUnprocessableEntity,
                                    "not enough artists with L1 data to pick a pair yet");
        }
        const auto i = utils::RandRange(candidates.size());
        auto       j = utils::RandRange(candidates.size());
        if (j == i) j = (j + 1) % candidates.size();
        from = candidates[i];
        to   = candidates[j];
    }

    if (from == to) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(request, server::http::HttpStatus::kBadRequest,
                                "from and to must differ");
    }

    const auto path = FindIdealPath(neighbours_, from, to, kAllRolesMask);
    if (!path) {
        response.SetStatus(server::http::HttpStatus::kUnprocessableEntity);
        return BuildProblemJson(request, server::http::HttpStatus::kUnprocessableEntity,
                                "no ideal path — L1 doesn't connect this pair (yet)");
    }
    const int path_len = static_cast<int>(path->size()) - 1;

    const auto season = store_.EnsureCurrentSeason();
    auto challenge = store_.UpsertChallenge(from, to, kAllRolesMask, "daily",
                                            std::nullopt, season.id);
    if (!challenge.optimal_len) {
        store_.SetChallengeIdeal(challenge.id, path_len, *path);
        challenge.optimal_len = path_len;
    }

    return DailyPublishedJson(challenge.id, from, to, kAllRolesMask, challenge.optimal_len);
}

yaml_config::Schema AdminHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
        kGameAdminHandlerSchema);
}

} // namespace six_feat::game
