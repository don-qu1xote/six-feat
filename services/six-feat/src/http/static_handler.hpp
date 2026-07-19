#pragma once

#include <string>
#include <string_view>

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
  // that was just read from disk (e.g. to inline the hashed script/style
  // URLs) before it's served. Called once, from the constructor.
  static std::string TransformContent(const userver::components::ComponentConfig &config,
                                       std::string content);

private:
  // Replaces every occurrence of `placeholder` in `content` with
  // `replacement`. No-op when either is empty. Used by TransformContent for
  // the "/script.js" and "/style.css" → hashed-URL rewrites.
  static std::string ReplaceAll(std::string content,
                                std::string_view placeholder,
                                const std::string &replacement);

private:
  const std::string content_;
  const std::string content_type_;
  const std::string cache_control_;
};

// Serves index.html. At startup, any occurrence of the literal string
// "/script.js" inside the file is rewritten to the content-hashed script
// URL (e.g. "/script.a1b2c3d4.js"), read from the "script-url" config value;
// [SF-WEB-40] likewise "/style.css" → the hashed CSS bundle URL via
// "style-url". This is what lets the browser pick up a new JS/CSS bundle on
// a normal (non-hard) refresh: index.html itself is served with
// Cache-Control: no-cache, so it's always revalidated, and it always points
// at whatever hashed asset URLs were baked in at image-build time.
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

// [SF-WEB-40] Serves the hashed CSS bundle (src/styles/ → esbuild →
// dist/style.<hash>.css). Content-addressed like the JS bundle, so served
// with the same long, immutable cache lifetime.
class StyleHandler final : public StaticFileHandler {
public:
  static constexpr std::string_view kName = "handler-style";
  using StaticFileHandler::StaticFileHandler;
};

// [SF-SEC-02] Serves the self-hosted vis-network vendor bundle (see
// front/vendor/vis-network.min.js) at /vendor/vis-network.min.js — replaces
// the old https://unpkg.com/vis-network@.../standalone/umd/vis-network.min.js
// CDN <script> tag (integrity/crossorigin dropped: same-origin now, and no
// longer depends on unpkg.com serving byte-for-byte the same file the SRI
// hash was computed against). Version-pinned like the CDN URL was, just
// tracked as a vendored file instead — see DEVELOPMENT.md for how to bump it.
class VendorVisNetworkHandler final : public StaticFileHandler {
public:
  static constexpr std::string_view kName = "handler-vendor-vis-network";
  using StaticFileHandler::StaticFileHandler;
};

// [SF-API-05] Serves the checked-in static OpenAPI 3.1 document
// (schemas/openapi/openapi.json) at GET /api/v1/openapi.json — hand-written
// and version-controlled, not generated from the running handlers, so it's
// a reviewable artifact like every other schema under schemas/.
class OpenApiHandler final : public StaticFileHandler {
public:
  static constexpr std::string_view kName = "handler-openapi";
  using StaticFileHandler::StaticFileHandler;
};

} // namespace six_feat
