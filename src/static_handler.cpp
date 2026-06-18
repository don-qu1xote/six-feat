#include "static_handler.hpp"

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/fs/blocking/read.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

StaticFileHandler::StaticFileHandler(
    const components::ComponentConfig& config,
    const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      // Read once at startup; subsequent requests are served from memory.
      content_(fs::blocking::ReadFileContents(
          config["file-path"].As<std::string>())),
      content_type_(config["content-type"].As<std::string>(
          "text/plain; charset=utf-8")) {}

std::string StaticFileHandler::HandleRequestThrow(
    const server::http::HttpRequest& request,
    server::request::RequestContext& /*context*/) const {
  request.GetHttpResponse().SetContentType(http::ContentType{content_type_});
  return content_;
}

yaml_config::Schema StaticFileHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(R"(
type: object
description: Serves a single static file (HTML/JS/CSS) read from disk at startup
additionalProperties: false
properties:
    file-path:
        type: string
        description: path to the file to read and serve
    content-type:
        type: string
        description: value for the Content-Type response header
        defaultDescription: text/plain; charset=utf-8
)");
}

}  // namespace six_feat
