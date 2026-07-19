#include "profile_handler.hpp"

#include "game_session.hpp"
#include "game_store.hpp"
#include "auth/session_crypto.hpp"
#include "core/error_response.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/handlers/game/profile_handler_schema.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <optional>
#include <string>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_method.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_status.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::game {

using namespace userver;

namespace {

constexpr std::size_t kMaxDisplayName = 32;

// [SF-GAME-12] display_name validation: length + a light-touch censor. Returns
// the normalized name on success, or an error message on rejection. A starter
// blocklist (substring, case-insensitive) — the point is that the seam exists,
// not that it's exhaustive; a real deployment swaps in a maintained list.
const char* const kBlocked[] = {"nigger", "faggot", "retard"};

std::optional<std::string> ValidateDisplayName(const std::string& raw,
                                               std::string& error) {
    // Trim surrounding whitespace.
    std::size_t b = raw.find_first_not_of(" \t\r\n");
    std::size_t e = raw.find_last_not_of(" \t\r\n");
    if (b == std::string::npos) { error = "display_name must not be blank"; return std::nullopt; }
    std::string name = raw.substr(b, e - b + 1);

    if (name.size() > kMaxDisplayName) {
        error = "display_name must be at most 32 characters";
        return std::nullopt;
    }
    for (unsigned char c : name) {
        if (std::iscntrl(c)) { error = "display_name contains control characters"; return std::nullopt; }
    }
    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    for (const char* bad : kBlocked) {
        if (lower.find(bad) != std::string::npos) {
            error = "display_name is not allowed";
            return std::nullopt;
        }
    }
    return name;
}

std::string ProfileJson(const Profile& p) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["user_id"]      = p.user_id;
    b["display_name"] = p.display_name;
    b["avatar_url"]   = p.avatar_url;
    b["elo"]          = p.elo;
    b["games"]        = p.games;
    b["rank"]         = p.rank;
    return formats::json::ToString(b.ExtractValue());
}

} // namespace

ProfileHandler::ProfileHandler(const components::ComponentConfig&  config,
                               const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , store_(context.FindComponent<GameStore>())
    // Session key derived straight from APP_SECRET (KeyFromEnv) — the game
    // service has no Genius OAuth app config, and decryption is local, so it
    // never needs OAuthConfig. Computed once; APP_SECRET is fixed per process.
    , session_key_(auth::KeyFromEnv())
{}

std::string ProfileHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    auto& response = request.GetHttpResponse();

    const auto player = ResolvePlayer(request, session_key_);
    if (!player) {
        response.SetStatus(server::http::HttpStatus::kUnauthorized);
        return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized,
                                "not authenticated");
    }

    response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    // GET — own profile (created on first sight).
    if (request.GetMethod() == server::http::HttpMethod::kGet) {
        return ProfileJson(store_.EnsureAndGetProfile(player->user_id, player->name, ""));
    }

    // PATCH — change display_name.
    std::string parse_error;
    std::string requested;
    try {
        const auto body = formats::json::FromString(request.RequestBody());
        requested = body["display_name"].As<std::string>("");
    } catch (const std::exception&) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(request, server::http::HttpStatus::kBadRequest,
                                "body must be JSON with a display_name field");
    }

    std::string error;
    const auto valid = ValidateDisplayName(requested, error);
    if (!valid) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(request, server::http::HttpStatus::kBadRequest, error);
    }

    // Ensure the row exists (first PATCH before any GET), then update it.
    store_.EnsureAndGetProfile(player->user_id, player->name, "");
    return ProfileJson(store_.SetDisplayName(player->user_id, *valid));
}

// static
yaml_config::Schema ProfileHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
        kGameProfileHandlerSchema);
}

} // namespace six_feat::game
