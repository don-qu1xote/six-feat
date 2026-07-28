#include "http/static_handler.hpp"

#include "schemas/handlers/six-feat/static_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/fs/blocking/read.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

StaticFileHandler::StaticFileHandler(const components::ComponentConfig& config,
                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      content_(TransformContent(
          config, fs::blocking::ReadFileContents(config["file-path"].As<std::string>()))),
      content_type_(config["content-type"].As<std::string>("text/plain; charset=utf-8")),
      cache_control_(config["cache-control"].As<std::string>("")) {}

std::string StaticFileHandler::ReplaceAll(std::string content,
                                          std::string_view placeholder,
                                          const std::string& replacement) {
  if (placeholder.empty() || replacement.empty()) {
    return content;
  }
  std::string result;
  result.reserve(content.size());
  std::size_t pos = 0;
  while (true) {
    const auto found = content.find(placeholder, pos);
    if (found == std::string::npos) {
      result.append(content, pos, std::string::npos);
      break;
    }
    result.append(content, pos, found - pos);
    result.append(replacement);
    pos = found + placeholder.size();
  }
  return result;
}

std::string StaticFileHandler::TransformContent(const components::ComponentConfig& config,
                                                std::string content) {
  content = ReplaceAll(std::move(content), "/script.js", config["script-url"].As<std::string>(""));
  content = ReplaceAll(std::move(content), "/style.css", config["style-url"].As<std::string>(""));
  return content;
}

std::string StaticFileHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                  server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
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

}  // namespace six_feat