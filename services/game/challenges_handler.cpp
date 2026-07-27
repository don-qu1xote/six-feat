#include "challenges_handler.hpp"

#include "core/error_response.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"

#include "schemas/handlers/game/challenges_handler_schema.hpp"

#include <cstddef>
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
#include <utility>

#include "game_store.hpp"

namespace six_feat::game {

using namespace userver;

namespace {

constexpr int kDefaultLimit = 24;
constexpr int kMaxLimit = 60;
constexpr std::size_t kMaxQueryLen = 80;

void PutArtist(formats::json::ValueBuilder& parent, const char* key, const ArtistRef& a) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["id"] = a.id;
  b["name"] = a.name;
  if (a.image_url && !a.image_url->empty()) b["image"] = *a.image_url;
  parent[key] = b.ExtractValue();
}

std::optional<std::pair<std::int64_t, std::int64_t>> ParseCursor(const std::string& raw,
                                                                 bool& malformed) {
  malformed = false;
  if (raw.empty()) return std::nullopt;
  const auto colon = raw.find(':');
  if (colon == std::string::npos) {
    malformed = true;
    return std::nullopt;
  }
  try {
    std::size_t p1 = 0, p2 = 0;
    const auto ts = std::stoll(raw.substr(0, colon), &p1);
    const auto id = std::stoll(raw.substr(colon + 1), &p2);
    if (p1 != colon || p2 != raw.size() - colon - 1 || id <= 0) {
      malformed = true;
      return std::nullopt;
    }
    return std::make_pair(ts, id);
  } catch (const std::exception&) {
    malformed = true;
    return std::nullopt;
  }
}

}  // namespace
ChallengesHandler::ChallengesHandler(const components::ComponentConfig& config,
                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context), store_(context.FindComponent<GameStore>()) {}

std::string ChallengesHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                  server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto& kind = request.GetArg("kind");
  if (!kind.empty() && kind != "daily" && kind != "custom") {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "kind must be omitted, 'daily' or 'custom'");
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
      return BuildProblemJson(
          request, server::http::HttpStatus::kBadRequest, "limit must be an integer");
    }
  }
  if (limit < 1 || limit > kMaxLimit) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "limit must be between 1 and " + std::to_string(kMaxLimit));
  }

  bool malformed = false;
  const auto& query = request.GetArg("q");
  if (query.size() > kMaxQueryLen) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "q must be at most " + std::to_string(kMaxQueryLen) + " characters");
  }

  const auto cursor = ParseCursor(request.GetArg("cursor"), malformed);
  if (malformed) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request, server::http::HttpStatus::kBadRequest, "cursor is malformed");
  }

  const auto items = store_.ListChallenges(kind, query, cursor, limit);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  formats::json::ValueBuilder arr(formats::json::Type::kArray);
  for (const auto& it : items) {
    formats::json::ValueBuilder cb(formats::json::Type::kObject);
    cb["id"] = it.challenge.id;
    cb["kind"] = it.challenge.kind;
    if (it.challenge.optimal_len) cb["optimal_len"] = *it.challenge.optimal_len;
    cb["created_ts"] = it.created_ts;
    PutArtist(cb, "from", it.from);
    PutArtist(cb, "to", it.to);
    arr.PushBack(cb.ExtractValue());
  }
  b["challenges"] = std::move(arr);

  if (static_cast<int>(items.size()) == limit && !items.empty()) {
    const auto& last = items.back();
    b["next_cursor"] = std::to_string(last.created_ts) + ":" + std::to_string(last.challenge.id);
  } else {
    b["next_cursor"] = formats::json::ValueBuilder(formats::json::Type::kNull).ExtractValue();
  }

  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema ChallengesHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGameChallengesHandlerSchema);
}

}  // namespace six_feat::game