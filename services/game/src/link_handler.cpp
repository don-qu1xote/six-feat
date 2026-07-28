#include "link_handler.hpp"

#include "schemas/handlers/game/link_handler_schema.hpp"

#include <algorithm>
#include <cstdint>
#include <optional>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "neighbours_client.hpp"

namespace six_feat::game {

using namespace userver;

namespace {

std::optional<std::int64_t> ParsePositiveId(const std::string& raw) {
  if (raw.empty()) return std::nullopt;
  try {
    std::size_t pos = 0;
    const auto id = std::stoll(raw, &pos);
    if (pos != raw.size() || id <= 0) return std::nullopt;
    return id;
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

}  // namespace
LinkHandler::LinkHandler(const components::ComponentConfig& config,
                         const components::ComponentContext& context)
    : HttpHandlerBase(config, context), neighbours_(context.FindComponent<NeighboursClient>()) {}

std::string LinkHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                            server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto from = ParsePositiveId(request.GetArg("from"));
  const auto to = ParsePositiveId(request.GetArg("to"));
  if (!from || !to) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "from and to are required positive integers");
  }

  int role_mask = 0;
  const auto& roles_arg = request.GetArg("roles");
  if (!roles_arg.empty()) {
    try {
      std::size_t pos = 0;
      role_mask = static_cast<int>(std::stol(roles_arg, &pos));
      if (pos != roles_arg.size() || role_mask < 0) role_mask = 0;
    } catch (const std::exception&) {
      role_mask = 0;
    }
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);

  const auto neighbours = neighbours_.Neighbours(*from, role_mask);
  if (!neighbours) {
    b["linked"] = formats::json::ValueBuilder(formats::json::Type::kNull).ExtractValue();
    return formats::json::ToString(b.ExtractValue());
  }

  const bool linked = std::find(neighbours->begin(), neighbours->end(), *to) != neighbours->end();
  b["linked"] = linked;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema LinkHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGameLinkHandlerSchema);
}

}  // namespace six_feat::game