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

protected:
  // Allows a derived class (IndexHandler) to post-process the file content
  // that was just read from disk (e.g. to inline the hashed script URL)
  // before it's served. Called once, from the constructor.
  static std::string TransformContent(const userver::components::ComponentConfig &config,
                                       std::string content);

private:
  const std::string content_;
  const std::string content_type_;
  const std::string cache_control_;
};

// Serves index.html. At startup, any occurrence of the literal string
// "/script.js" inside the file is rewritten to the content-hashed script
// URL (e.g. "/script.a1b2c3d4.js"), read from the "script-url" config value.
// This is what lets the browser pick up a new JS bundle on a normal
// (non-hard) refresh: index.html itself is served with Cache-Control:
// no-cache, so it's always revalidated, and it always points at whatever
// hashed script URL was baked in at image-build time.
class IndexHandler final : public StaticFileHandler {
public:
  static constexpr std::string_view kName = "handler-index";
  using StaticFileHandler::StaticFileHandler;
};

// Serves the hashed JS bundle. Content-addressed file names never change
// content under a given URL, so this is served with a long, immutable
// cache lifetime.
class ScriptHandler final : public StaticFileHandler {
public:
  static constexpr std::string_view kName = "handler-script";
  using StaticFileHandler::StaticFileHandler;
};

} // namespace six_feat
