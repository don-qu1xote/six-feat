#include "leaderboard_handler.hpp"

#include "game_store.hpp"
#include "core/error_response.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/handlers/game/leaderboard_handler_schema.hpp"

#include <algorithm>
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

constexpr int kDefaultLimit = 20;
constexpr int kMaxLimit     = 100;

std::optional<std::int64_t> ParsePositiveId(const std::string& raw) {
    if (raw.empty()) return std::nullopt;
    try {
        std::size_t pos = 0;
        const auto  id  = std::stoll(raw, &pos);
        if (pos != raw.size() || id <= 0) return std::nullopt;
        return id;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

std::string PageJson(const LeaderboardPage& page) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    formats::json::ValueBuilder entries(formats::json::Type::kArray);
    for (const auto& e : page.entries) {
        formats::json::ValueBuilder eb(formats::json::Type::kObject);
        eb["user_id"]      = e.user_id;
        eb["display_name"] = e.display_name;
        eb["score"]        = e.score;
        eb["hops"]         = e.hops;
        eb["ts"]           = e.ts;
        entries.PushBack(eb.ExtractValue());
    }
    b["entries"] = std::move(entries);
    if (page.next_cursor) {
        b["next_cursor"] = *page.next_cursor;
    } else {
        b["next_cursor"] = formats::json::ValueBuilder(formats::json::Type::kNull).ExtractValue();
    }
    return formats::json::ToString(b.ExtractValue());
}

} // namespace

LeaderboardHandler::LeaderboardHandler(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , store_(context.FindComponent<GameStore>())
    , cache_ttl_(std::chrono::milliseconds{config["cache-ttl-ms"].As<int>(15000)})
{}

std::string LeaderboardHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    auto& response = request.GetHttpResponse();
    response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

    const auto& challenge_arg = request.GetArg("challenge_id");
    const auto& season_arg    = request.GetArg("season_id");
    const bool  has_challenge = !challenge_arg.empty();
    const bool  has_season    = !season_arg.empty();

    if (has_challenge == has_season) {  // neither, or both — both invalid
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(
            request, server::http::HttpStatus::kBadRequest,
            "exactly one of ?challenge_id= or ?season_id= is required");
    }

    const auto scope    = has_challenge ? LeaderboardScope::kChallenge : LeaderboardScope::kSeason;
    const auto scope_id = ParsePositiveId(has_challenge ? challenge_arg : season_arg);
    if (!scope_id) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(request, server::http::HttpStatus::kBadRequest,
                                "id must be a positive integer");
    }

    int limit = kDefaultLimit;
    const auto& limit_arg = request.GetArg("limit");
    if (!limit_arg.empty()) {
        try {
            std::size_t pos = 0;
            limit = static_cast<int>(std::stol(limit_arg, &pos));
            if (pos != limit_arg.size()) throw std::invalid_argument("trailing garbage");
        } catch (const std::exception&) {
            response.SetStatus(server::http::HttpStatus::kBadRequest);
            return BuildProblemJson(request, server::http::HttpStatus::kBadRequest,
                                    "limit must be an integer");
        }
    }
    if (limit < 1 || limit > kMaxLimit) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(
            request, server::http::HttpStatus::kBadRequest,
            "limit must be between 1 and " + std::to_string(kMaxLimit));
    }

    const auto& cursor_arg = request.GetArg("cursor");
    const std::optional<std::string> cursor =
        cursor_arg.empty() ? std::nullopt : std::optional<std::string>(cursor_arg);

    // [SF-PERF-06] Only page 1 (no cursor) is cache-eligible — see this
    // class's own header comment.
    if (!cursor) {
        const std::string cache_key =
            (has_challenge ? std::string{"challenge:"} : std::string{"season:"}) +
            std::to_string(*scope_id) + ":" + std::to_string(limit);

        {
            std::unique_lock lock(cache_mu_);
            const auto it = cache_.find(cache_key);
            if (it != cache_.end() && it->second.expires_at > std::chrono::steady_clock::now()) {
                return it->second.body;
            }
        }

        const auto page = store_.GetLeaderboard(scope, *scope_id, std::nullopt, limit);
        const auto body = PageJson(page);

        std::unique_lock lock(cache_mu_);
        cache_[cache_key] = CacheEntry{body, std::chrono::steady_clock::now() + cache_ttl_};
        return body;
    }

    const auto page = store_.GetLeaderboard(scope, *scope_id, cursor, limit);
    return PageJson(page);
}

yaml_config::Schema LeaderboardHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
        kGameLeaderboardHandlerSchema);
}

} // namespace six_feat::game
