#include "submit_handler.hpp"

#include "core/chain_validator.hpp"
#include "core/game_session.hpp"
#include "core/game_store.hpp"

#include "schemas/handlers/game/submit_handler_schema.hpp"

#include <cstdint>
#include <optional>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

#include "infrastructure/neighbours_client.hpp"

namespace six_feat::game {

using namespace userver;

namespace {

std::string RejectedJson(const ChainValidationResult& result) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["valid"] = false;
  switch (result.status) {
    case ChainValidationStatus::kInvalidHop:
      b["reason"] = "invalid_hop";
      b["invalid_hop_index"] = *result.invalid_hop_index;
      break;
    case ChainValidationStatus::kEndpointMismatch:
    default:
      b["reason"] = "endpoint_mismatch";
      break;
  }
  return formats::json::ToString(b.ExtractValue());
}

}  // namespace
SubmitHandler::SubmitHandler(const components::ComponentConfig& config,
                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      store_(context.FindComponent<GameStore>()),
      neighbours_(context.FindComponent<NeighboursClient>()),
      session_key_(auth::KeyFromEnv()),
      rate_limit_(
          "game-submit", 5, 10, context.FindComponent<RateLimitStoreComponent>().MakeStore()) {}

std::string SubmitHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                              server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();

  const auto player = ResolvePlayer(request, session_key_);
  if (!player) {
    response.SetStatus(server::http::HttpStatus::kUnauthorized);
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  if (!rate_limit_.Allow(std::to_string(player->user_id))) {
    LOG_WARNING() << "[SubmitHandler] rate limit hit for user_id=" << player->user_id;
    response.SetStatus(server::http::HttpStatus::kTooManyRequests);
    response.SetHeader(std::string{"Retry-After"}, std::string{"10"});
    return BuildProblemJson(
        request, server::http::HttpStatus::kTooManyRequests, "too many submissions — slow down");
  }

  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  std::int64_t challenge_id = 0;
  std::vector<std::int64_t> chain;
  std::optional<int> elapsed_ms;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    challenge_id = body["challenge_id"].As<std::int64_t>(0);
    for (const auto& v : body["chain"]) chain.push_back(v.As<std::int64_t>());
    const int elapsed_raw = body["elapsed_ms"].As<int>(-1);
    if (elapsed_raw >= 0) elapsed_ms = elapsed_raw;
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request,
        server::http::HttpStatus::kBadRequest,
        "body must be JSON with challenge_id (int64) and chain (array of int64)");
  }

  if (challenge_id <= 0 || chain.size() < 2) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "challenge_id is required and chain must have at least 2 artists");
  }

  const auto challenge = store_.GetChallenge(challenge_id);
  if (!challenge) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return BuildProblemJson(request, server::http::HttpStatus::kNotFound, "no such challenge");
  }
  if (!challenge->optimal_len) {
    response.SetStatus(server::http::HttpStatus::kConflict);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kConflict,
                            "this challenge's ideal path hasn't been computed yet");
  }

  const auto result = ValidateChain(
      neighbours_, challenge->from_artist_id, challenge->to_artist_id, chain, challenge->role_mask);

  if (result.status == ChainValidationStatus::kUnavailable) {
    LOG_WARNING() << "[SubmitHandler] chain verification unavailable "
                     "for user_id="
                  << player->user_id << " challenge_id=" << challenge_id;
    response.SetStatus(server::http::HttpStatus::kServiceUnavailable);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kServiceUnavailable,
                            "could not verify chain right now — try again");
  }

  if (result.status != ChainValidationStatus::kValid) {
    store_.RecordInvalidAttempt(player->user_id, challenge_id, chain);
    return RejectedJson(result);
  }

  store_.EnsureAndGetProfile(player->user_id, player->name, "");

  const auto outcome = store_.RecordValidAttempt(player->user_id,
                                                 challenge_id,
                                                 chain,
                                                 *challenge->optimal_len,
                                                 elapsed_ms,
                                                 challenge->season_id);

  const auto unlocked = store_.EvaluateAndAwardAchievements(player->user_id, outcome, elapsed_ms);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["valid"] = true;
  b["player_len"] = outcome.player_len;
  b["optimal_len"] = *challenge->optimal_len;
  formats::json::ValueBuilder path(formats::json::Type::kArray);
  for (const auto id : challenge->optimal_path) path.PushBack(id);
  b["optimal_path"] = std::move(path);
  b["score"] = outcome.score;
  b["max_score"] = outcome.max_score;
  b["elo_before"] = outcome.elo_before;
  b["elo_after"] = outcome.elo_after;
  b["elo_delta"] = outcome.elo_delta;
  if (!unlocked.empty()) {
    formats::json::ValueBuilder ach(formats::json::Type::kArray);
    for (const auto& code : unlocked) ach.PushBack(code);
    b["achievements_unlocked"] = std::move(ach);
  }
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SubmitHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGameSubmitHandlerSchema);
}

}  // namespace six_feat::game