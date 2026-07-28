
#include "artist_handler.hpp"

#include "schemas/handlers/six-feat/artist_handler_schema.hpp"

#include <six-feat-core/error_response.hpp>
#include <six-feat-core/http_cache.hpp>
#include <string>
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

std::string BuildArtistETag(std::int64_t artist_id, const FetchState& fs) {
  return "W/\"" + std::to_string(artist_id) + "-" + std::to_string(static_cast<int>(fs.depth)) +
         "-" + std::to_string(fs.song_count) + "-" + std::to_string(fs.last_fetch_ts) + "\"";
}

}  // namespace
ArtistHandler::ArtistHandler(const components::ComponentConfig& config,
                             const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      repo_(context.FindComponent<ArtistRepository>()),
      store_(context.FindComponent<PersistentStore>()) {}

std::string ArtistHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                              server::request::RequestContext&) const {
  if (!Prologue(request)) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  auto& response = request.GetHttpResponse();

  const auto& id_str = request.GetArg("id");
  if (id_str.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "missing ?id=<artist_id>");
  }

  std::int64_t artist_id = 0;
  try {
    std::size_t pos = 0;
    artist_id = std::stoll(id_str, &pos);
    if (pos != id_str.size()) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      return BuildProblemJson(
          request, server::http::HttpStatus::kBadRequest, "id must be an integer");
    }
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "id must be an integer");
  }

  const auto ref = repo_.Lookup(artist_id);
  if (!ref) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return BuildProblemJson(request, server::http::HttpStatus::kNotFound, "not_found");
  }

  const FetchState fetch_state = store_.GetFetchState(artist_id);

  const std::string etag = BuildArtistETag(artist_id, fetch_state);
  response.SetHeader(std::string{"ETag"}, etag);
  response.SetHeader(std::string{"Cache-Control"}, std::string{"private, must-revalidate"});

  const std::string& if_none_match = request.GetHeader(std::string_view{"If-None-Match"});
  if (ETagMatches(if_none_match, etag)) {
    response.SetStatus(server::http::HttpStatus::kNotModified);
    return {};
  }

  response.SetContentType(http::ContentType("application/json"));

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["id"] = ref->id;
  b["name"] = ref->name;
  if (!ref->image.empty()) b["image"] = ref->image;
  if (!ref->url.empty()) b["url"] = ref->url;

  formats::json::ValueBuilder fs(formats::json::Type::kObject);
  fs["depth"] = static_cast<int>(fetch_state.depth);
  fs["song_count"] = fetch_state.song_count;
  fs["last_fetch_ts"] = fetch_state.last_fetch_ts;
  b["fetch_state"] = std::move(fs);

  return formats::json::ToString(b.ExtractValue());
}

userver::yaml_config::Schema ArtistHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<HttpHandlerBase>(kArtistHandlerSchema);
}

}  // namespace six_feat