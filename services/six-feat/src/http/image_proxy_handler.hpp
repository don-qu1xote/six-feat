#pragma once

// ════════════════════════════════════════════════════════════════════════════
// image_proxy_handler.hpp  —  SF-API-12
//
// Same-origin proxy for Genius CDN artist/song avatars. Artist images come
// from images.genius.com / assets.genius.com without CORS headers, so the
// live #network <canvas> "taints" the moment one of those images is drawn
// onto it — PNG export (SF-WEB-04) has to swap every photo for a
// placeholder to work around that. GET /api/v1/image?url=<genius-cdn-url>
// re-serves the bytes from this service's own origin instead, so the
// browser never has to touch images.genius.com directly for canvas
// purposes.
//
// Security posture (see image_proxy_handler.cpp for the full reasoning):
//   - `url` must parse as http(s) with a host EXACTLY matching the
//     allowlist (kDefaultAllowedImageHosts, overridable via the
//     `allowed-hosts` static-config key — same testability pattern every
//     other external-dependency component in this service already uses,
//     e.g. genius-gateway-client's genius-gateway-base-url).
//   - Because the allowlist is host-only (no IP literals in it, ever, in
//     production), any private/loopback/link-local IP an attacker puts in
//     `?url=` directly is rejected by that same check — no separate IP-range
//     parsing needed.
//   - Redirects from the upstream are never followed — a 3xx response is
//     treated as a failure, since a redirect target could point anywhere,
//     including somewhere the host allowlist doesn't cover.
// ════════════════════════════════════════════════════════════════════════════

#include "http/authenticated_handler_base.hpp"
#include "auth/oauth_handler.hpp"

#include <chrono>
#include <string>
#include <string_view>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class ImageProxyHandler final : public AuthenticatedHandlerBase {
public:
    static constexpr std::string_view kName = "handler-image";

    ImageProxyHandler(const userver::components::ComponentConfig&  config,
                       const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  ctx) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    userver::clients::http::Client&       http_client_;
    const std::chrono::milliseconds       timeout_;
    // Lower-cased hostnames only — see LoadAllowedHosts (image_proxy_handler.cpp)
    // for how this defaults to kDefaultAllowedImageHosts.
    const std::vector<std::string>        allowed_hosts_;
};

} // namespace six_feat
