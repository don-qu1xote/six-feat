#include "profile_handler.hpp"

#include "core/error_response.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"

#include "auth/session_crypto.hpp"

#include "schemas/handlers/game/profile_handler_schema.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
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
#include <vector>

#include "game_session.hpp"
#include "game_store.hpp"

namespace six_feat::game {

using namespace userver;

namespace {

constexpr std::size_t kMaxDisplayName = 32;

constexpr std::array kBlocked = {"nigger", "faggot", "retard"};

std::optional<std::string> ValidateDisplayName(const std::string& raw, std::string& error) {
  std::size_t b = raw.find_first_not_of(" \t\r\n");
  std::size_t e = raw.find_last_not_of(" \t\r\n");
  if (b == std::string::npos) {
    error = "display_name must not be blank";
    return std::nullopt;
  }
  std::string name = raw.substr(b, e - b + 1);

  if (name.size() > kMaxDisplayName) {
    error = "display_name must be at most 32 characters";
    return std::nullopt;
  }
  for (unsigned char c : name) {
    if (std::iscntrl(c)) {
      error = "display_name contains control characters";
      return std::nullopt;
    }
  }
  std::string lower = name;
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  for (const char* bad : kBlocked) {
    if (lower.find(bad) != std::string::npos) {
      error = "display_name is not allowed";
      return std::nullopt;
    }
  }
  return name;
}

formats::json::ValueBuilder AchievementsArray(const std::vector<Achievement>& achievements) {
  formats::json::ValueBuilder arr(formats::json::Type::kArray);
  for (const auto& a : achievements) {
    formats::json::ValueBuilder ab(formats::json::Type::kObject);
    ab["code"] = a.code;
    ab["title"] = a.title;
    ab["descr"] = a.descr;
    ab["ts"] = a.ts;
    arr.PushBack(ab.ExtractValue());
  }
  return arr;
}

std::string ProfileJson(const Profile& p, const std::vector<Achievement>& achievements) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["user_id"] = p.user_id;
  b["display_name"] = p.display_name;
  b["avatar_url"] = p.avatar_url;
  b["elo"] = p.elo;
  b["games"] = p.games;
  b["rank"] = p.rank;
  b["achievements"] = AchievementsArray(achievements);
  return formats::json::ToString(b.ExtractValue());
}

std::string PublicProfileJson(const Profile& p,
                              const std::vector<AttemptSummary>& history,
                              const std::vector<Achievement>& achievements) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["user_id"] = p.user_id;
  b["display_name"] = p.display_name;
  b["avatar_url"] = p.avatar_url;
  b["elo"] = p.elo;
  b["games"] = p.games;
  b["rank"] = p.rank;
  b["achievements"] = AchievementsArray(achievements);
  formats::json::ValueBuilder hist(formats::json::Type::kArray);
  for (const auto& a : history) {
    formats::json::ValueBuilder ab(formats::json::Type::kObject);
    ab["challenge_id"] = a.challenge_id;
    ab["valid"] = a.valid;
    ab["score"] = a.score;
    ab["hops"] = a.hops;
    ab["ts"] = a.ts;
    hist.PushBack(ab.ExtractValue());
  }
  b["history"] = std::move(hist);
  return formats::json::ToString(b.ExtractValue());
}

constexpr int kHistoryLimit = 20;

}  // namespace
ProfileHandler::ProfileHandler(const components::ComponentConfig& config,
                               const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      store_(context.FindComponent<GameStore>()),
      session_key_(auth::KeyFromEnv()) {}

std::string ProfileHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                               server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();

  if (request.GetMethod() == server::http::HttpMethod::kGet) {
    const auto& user_arg = request.GetArg("user");
    if (!user_arg.empty()) {
      response.SetContentType(http::ContentType{"application/json; charset=utf-8"});
      std::int64_t user_id = 0;
      try {
        std::size_t pos = 0;
        user_id = std::stoll(user_arg, &pos);
        if (pos != user_arg.size() || user_id <= 0) throw std::invalid_argument("bad user");
      } catch (const std::exception&) {
        response.SetStatus(server::http::HttpStatus::kBadRequest);
        return BuildProblemJson(
            request, server::http::HttpStatus::kBadRequest, "user must be a positive integer");
      }
      const auto profile = store_.GetProfileIfExists(user_id);
      if (!profile) {
        response.SetStatus(server::http::HttpStatus::kNotFound);
        return BuildProblemJson(request, server::http::HttpStatus::kNotFound, "no such player");
      }
      const auto history = store_.ListRecentAttempts(user_id, kHistoryLimit);
      const auto achievements = store_.ListAchievements(user_id);
      return PublicProfileJson(*profile, history, achievements);
    }
  }

  const auto player = ResolvePlayer(request, session_key_);
  if (!player) {
    response.SetStatus(server::http::HttpStatus::kUnauthorized);
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (request.GetMethod() == server::http::HttpMethod::kGet) {
    const auto profile = store_.EnsureAndGetProfile(player->user_id, player->name, "");
    return ProfileJson(profile, store_.ListAchievements(player->user_id));
  }

  std::string parse_error;
  std::string requested;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    requested = body["display_name"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "body must be JSON with a display_name field");
  }

  std::string error;
  const auto valid = ValidateDisplayName(requested, error);
  if (!valid) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request, server::http::HttpStatus::kBadRequest, error);
  }

  store_.EnsureAndGetProfile(player->user_id, player->name, "");
  const auto profile = store_.SetDisplayName(player->user_id, *valid);
  return ProfileJson(profile, store_.ListAchievements(player->user_id));
}

yaml_config::Schema ProfileHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGameProfileHandlerSchema);
}

}  // namespace six_feat::game