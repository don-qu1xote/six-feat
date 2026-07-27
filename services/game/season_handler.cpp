#include "season_handler.hpp"

#include "core/request_id.hpp"
#include "core/security_headers.hpp"

#include "schemas/handlers/game/season_handler_schema.hpp"

#include <optional>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "game_store.hpp"

namespace six_feat::game {

using namespace userver;

namespace {

constexpr int kPodiumSize = 5;

}
SeasonHandler::SeasonHandler(const components::ComponentConfig& config,
                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context), store_(context.FindComponent<GameStore>()) {}

std::string SeasonHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                              server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto season = store_.EnsureCurrentSeason();
  const auto podium =
      store_.GetLeaderboard(LeaderboardScope::kSeason, season.id, std::nullopt, kPodiumSize);
  const auto catalog = store_.ListAchievementCatalog();

  formats::json::ValueBuilder b(formats::json::Type::kObject);

  formats::json::ValueBuilder sb(formats::json::Type::kObject);
  sb["id"] = season.id;
  sb["name"] = season.name;
  sb["starts_ts"] = season.starts_ts;
  sb["ends_ts"] = season.ends_ts;
  b["season"] = sb.ExtractValue();

  formats::json::ValueBuilder pb(formats::json::Type::kArray);
  for (const auto& e : podium.entries) {
    formats::json::ValueBuilder eb(formats::json::Type::kObject);
    eb["user_id"] = e.user_id;
    eb["display_name"] = e.display_name;
    eb["score"] = e.score;
    eb["hops"] = e.hops;
    eb["ts"] = e.ts;
    pb.PushBack(eb.ExtractValue());
  }
  b["podium"] = pb.ExtractValue();

  formats::json::ValueBuilder ab(formats::json::Type::kArray);
  for (const auto& a : catalog) {
    formats::json::ValueBuilder cb(formats::json::Type::kObject);
    cb["code"] = a.code;
    cb["title"] = a.title;
    cb["descr"] = a.descr;
    ab.PushBack(cb.ExtractValue());
  }
  b["achievements"] = ab.ExtractValue();

  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SeasonHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGameSeasonHandlerSchema);
}

}  // namespace six_feat::game