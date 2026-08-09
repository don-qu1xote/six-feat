#include "music_source_edges_handler.hpp"

#include "schemas/handlers/six-feat/music_source_edges_handler_schema.hpp"

#include <six-feat-common/music_source_provider.hpp>
#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/request_id.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

std::string ErrorJson(const std::string& error) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["error"] = error;
  return formats::json::ToString(b.ExtractValue());
}

bool SecretMatches(const server::http::HttpRequest& request, const std::string& expected) {
  const std::string& given = request.GetHeader(internal_api::kSecretHeader);
  return internal_api::SecretEquals(given, expected);
}

}  // namespace

MusicSourceEdgesHandler::MusicSourceEdgesHandler(const components::ComponentConfig& config,
                                                 const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      source_(context.FindComponent<GeniusMusicSourceProvider>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string MusicSourceEdgesHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                        server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return ErrorJson("unauthorized");
  }

  std::int64_t seed_id = 0;
  std::string seed_name, user_token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    seed_id = body["id"].As<std::int64_t>(0);
    seed_name = body["name"].As<std::string>("");
    user_token = body["user_token"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("invalid JSON body");
  }

  if (seed_id <= 0 || seed_name.empty() || user_token.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("id, name and user_token are required");
  }

  ArtistRef seed;
  seed.id = seed_id;
  seed.name = seed_name;

  try {
    const auto edges = source_.GetCollaborationEdges(seed, user_token);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    formats::json::ValueBuilder arr(formats::json::Type::kArray);
    for (const auto& edge : edges) {
      formats::json::ValueBuilder e(formats::json::Type::kObject);
      e["from"] = edge.from;
      e["to"] = edge.to;
      e["source"] = ToString(edge.source);
      e["role"] = edge.role;
      arr.PushBack(e.ExtractValue());
    }
    b["edges"] = std::move(arr);
    return formats::json::ToString(b.ExtractValue());
  } catch (const std::exception& ex) {
    resp.SetStatus(server::http::HttpStatus::kServiceUnavailable);
    return ErrorJson(std::string("all music-source providers unavailable: ") + ex.what());
  }
}

yaml_config::Schema MusicSourceEdgesHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kMusicSourceEdgesHandlerSchema);
}

}  // namespace six_feat
