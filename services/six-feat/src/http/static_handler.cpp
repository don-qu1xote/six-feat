#include "http/static_handler.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/handlers/six-feat/static_handler_schema.hpp"

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/fs/blocking/read.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

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
  // [SF-SEC-03] Content-Security-Policy/X-Content-Type-Options/
  // Referrer-Policy/Strict-Transport-Security/Permissions-Policy now all
  // come from the shared ApplySecurityHeaders (security_headers.cpp) —
  // this handler used to hand-roll all but Permissions-Policy itself,
  // including an unconditional Strict-Transport-Security that ignored
  // IsHttpsDeployment()/COOKIE_SECURE=false (i.e. it would have told a
  // plain-HTTP local-dev browser to only ever speak HTTPS to us, exactly
  // the mistake that check exists everywhere else to avoid — folding this
  // into the shared function fixes that inconsistency along with adding
  // Permissions-Policy). X-Frame-Options stays local: it's this handler's
  // own concern (an HTML document being iframed), not something a JSON API
  // response needs, so it isn't part of the shared baseline.
  ApplySecurityHeaders(request);

  auto &response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{content_type_});
  response.SetHeader(std::string_view{"X-Frame-Options"}, "DENY");
  if (!cache_control_.empty()) {
    response.SetHeader(std::string_view{"Cache-Control"}, cache_control_);
  }
  return content_;
}

yaml_config::Schema StaticFileHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kStaticHandlerSchema);
}

} // namespace six_feat
