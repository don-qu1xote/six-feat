#include "http/static_handler.hpp"
#include "core/request_id.hpp"
#include "schemas/handlers/six-feat/static_handler_schema.hpp"

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/fs/blocking/read.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

// Genius API artist/song images are served from images.genius.com (verified
// against genius_gateway.cpp: image_url is passed through as-is from the
// Genius API JSON response) — but the "no artwork" placeholder Genius itself
// falls back to (default_cover_image.png, seen on any artist/song without
// real art) is served from the separate assets.genius.com host, not
// images.genius.com. Without it here, every such node's image is CSP-blocked
// — and since visuals.js's _imageFieldsFor re-sends the image URL on every
// hover partial-update (structural fix for vis.js dropping avatars across
// updates), each hover on one of those nodes re-triggers a blocked load ->
// fallback swap instead of just rendering the cached placeholder, which is
// the flicker reported on hover. Everything else the front-end loads is
// either same-origin, Google Fonts, or the vis-network CDN bundle.
constexpr std::string_view kContentSecurityPolicy =
    "default-src 'self'; "
    "img-src 'self' https://images.genius.com https://assets.genius.com data:; "
    "connect-src 'self' https://unpkg.com; "
    "script-src 'self' https://unpkg.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "frame-ancestors 'none'";

} // namespace

StaticFileHandler::StaticFileHandler(
    const components::ComponentConfig &config,
    const components::ComponentContext &context)
    : HttpHandlerBase(config, context),
      content_(TransformContent(
          config, fs::blocking::ReadFileContents(
                      config["file-path"].As<std::string>()))),
      content_type_(
          config["content-type"].As<std::string>("text/plain; charset=utf-8")),
      cache_control_(config["cache-control"].As<std::string>("")) {
}

std::string StaticFileHandler::TransformContent(
    const components::ComponentConfig &config, std::string content) {
  // Optional "script-url" config value: if present, every occurrence of the
  // literal "/script.js" in the file is replaced with it. Used by
  // handler-index so index.html always references the actual
  // content-hashed JS bundle name baked into the image at build time,
  // without hard-coding it into the source file itself.
  const auto script_url = config["script-url"].As<std::string>("");
  if (script_url.empty()) {
    return content;
  }

  constexpr std::string_view kPlaceholder = "/script.js";
  std::string result;
  result.reserve(content.size());
  std::size_t pos = 0;
  while (true) {
    const auto found = content.find(kPlaceholder, pos);
    if (found == std::string::npos) {
      result.append(content, pos, std::string::npos);
      break;
    }
    result.append(content, pos, found - pos);
    result.append(script_url);
    pos = found + kPlaceholder.size();
  }
  return result;
}

std::string StaticFileHandler::HandleRequestThrow(
    const server::http::HttpRequest &request,
    server::request::RequestContext & /*context*/) const {
  EnsureRequestId(request);

  auto &response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{content_type_});
  response.SetHeader(std::string_view{"Content-Security-Policy"},
                     std::string(kContentSecurityPolicy));
  response.SetHeader(std::string_view{"X-Content-Type-Options"}, "nosniff");
  response.SetHeader(std::string_view{"Referrer-Policy"},
                     "strict-origin-when-cross-origin");
  response.SetHeader(std::string_view{"X-Frame-Options"}, "DENY");
  response.SetHeader(std::string_view{"Strict-Transport-Security"},
                     "max-age=31536000; includeSubDomains");
  if (!cache_control_.empty()) {
    response.SetHeader(std::string_view{"Cache-Control"}, cache_control_);
  }
  return content_;
}

yaml_config::Schema StaticFileHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kStaticHandlerSchema);
}

} // namespace six_feat
