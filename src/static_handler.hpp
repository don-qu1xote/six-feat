#pragma once

#include <string>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class StaticFileHandler : public userver::server::handlers::HttpHandlerBase {
public:
  StaticFileHandler(const userver::components::ComponentConfig &config,
                    const userver::components::ComponentContext &context);

  std::string HandleRequestThrow(
      const userver::server::http::HttpRequest &request,
      userver::server::request::RequestContext &context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

private:
  const std::string content_;
  const std::string content_type_;
};

class IndexHandler final : public StaticFileHandler {
public:
  static constexpr std::string_view kName = "handler-index";
  using StaticFileHandler::StaticFileHandler;
};

class ScriptHandler final : public StaticFileHandler {
public:
  static constexpr std::string_view kName = "handler-script";
  using StaticFileHandler::StaticFileHandler;
};

} // namespace six_feat
