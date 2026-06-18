#pragma once

#include <string>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// Reads one file from disk at startup and serves its bytes on every request,
// with a configurable Content-Type. Used for the frontend (HTML + JS).
//
// All userver symbols are qualified with `userver::` because the framework is
// consumed as an installed package (find_package) where everything lives in
// the userver namespace.
class StaticFileHandler : public userver::server::handlers::HttpHandlerBase {
 public:
  StaticFileHandler(const userver::components::ComponentConfig& config,
                    const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(
      const userver::server::http::HttpRequest& request,
      userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  const std::string content_;
  const std::string content_type_;
};

// Two concrete components so each can have its own path/file in the config.
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

}  // namespace six_feat
