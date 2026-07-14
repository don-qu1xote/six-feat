// ════════════════════════════════════════════════════════════════════════════
// image_proxy_handler.cpp  —  SF-API-12
// ════════════════════════════════════════════════════════════════════════════

#include "http/image_proxy_handler.hpp"
#include "core/request_id.hpp"
#include "schemas/handlers/six-feat/image_proxy_handler_schema.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

// [SF-API-12] Real Genius CDN hosts — verified against
// static_handler.cpp's CSP img-src allowlist and genius_gateway.cpp's
// NormalizeArtistImageUrl comment: images.genius.com serves real
// artist/song artwork, assets.genius.com serves Genius's own
// fallback/default avatar. This is the production default; `allowed-hosts`
// in static config can override it — same testability pattern every other
// external-dependency component in this service already uses
// (genius-gateway-client's genius-gateway-base-url, enrichment-client's
// enrichment-base-url, app-secret-parity-checker's auth-base-url), so
// tests can point this handler at a local stub instead of the real
// internet, exactly like those. The shipped static_config.yaml never sets
// `allowed-hosts`, so production always gets exactly this compiled-in set.
constexpr std::array<std::string_view, 2> kDefaultAllowedImageHosts = {
    "images.genius.com",
    "assets.genius.com",
};

std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

std::vector<std::string> LoadAllowedHosts(const yaml_config::YamlConfig& config) {
    auto hosts = config["allowed-hosts"].As<std::vector<std::string>>(
        std::vector<std::string>{});
    if (hosts.empty()) {
        hosts.reserve(kDefaultAllowedImageHosts.size());
        for (const auto h : kDefaultAllowedImageHosts) hosts.emplace_back(h);
    }
    for (auto& h : hosts) h = ToLower(h);
    return hosts;
}

struct ParsedUrl {
    std::string scheme;
    std::string host;
};

// Minimal scheme://host[:port]/... splitter — good enough to validate an
// allowlisted CDN URL, not a general-purpose RFC 3986 parser. Deliberately
// simple/auditable rather than regex-based (regex-based URL validators are
// a classic source of both ReDoS and of subtly bypassable validation).
std::optional<ParsedUrl> ParseUrl(const std::string& url) {
    const auto scheme_end = url.find("://");
    if (scheme_end == std::string::npos) return std::nullopt;

    std::string scheme = ToLower(url.substr(0, scheme_end));

    const auto host_start = scheme_end + 3;
    if (host_start >= url.size()) return std::nullopt;

    const auto authority_end = url.find_first_of("/?#", host_start);
    const std::string authority = url.substr(
        host_start, authority_end == std::string::npos
                        ? std::string::npos
                        : authority_end - host_start);
    if (authority.empty()) return std::nullopt;

    // Reject embedded credentials (user:pass@host) — a classic allowlist-
    // bypass trick against parsers that only look at what comes right
    // after "://" up to the first '/', mistaking the "before @" segment
    // for the host.
    if (authority.find('@') != std::string::npos) return std::nullopt;

    // Strip a port (":8080") — the allowlist compares hostname only. IPv6
    // literals ("[::1]:8080") aren't handled specially: they'd fail the
    // hostname allowlist check regardless (never in it), same outcome as
    // any other non-allowlisted host.
    std::string host = authority;
    const auto port_pos = host.find(':');
    if (port_pos != std::string::npos) host = host.substr(0, port_pos);
    if (host.empty()) return std::nullopt;

    return ParsedUrl{std::move(scheme), ToLower(std::move(host))};
}

bool IsAllowedHost(const std::vector<std::string>& allowed, const std::string& host) {
    return std::find(allowed.begin(), allowed.end(), host) != allowed.end();
}

bool IsImageContentType(const std::string& content_type) {
    return content_type.rfind("image/", 0) == 0;
}

// [SF-API-06] Same local-error-envelope convention every other handler in
// this service uses (graph/path/search/status/sse_status) — see
// status_handler.cpp for the canonical comment. No shared SF-API-11
// envelope exists in this codebase yet.
std::string ErrorJson(const std::string& code) {
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["error"]      = code;
    b["request_id"] = CurrentRequestId();
    return formats::json::ToString(b.ExtractValue());
}

std::string BadRequest(const server::http::HttpRequest& request, const std::string& code) {
    request.GetHttpResponse().SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson(code);
}

std::string BadGateway(const server::http::HttpRequest& request, const std::string& code) {
    request.GetHttpResponse().SetStatus(server::http::HttpStatus::kBadGateway);
    return ErrorJson(code);
}

} // namespace

ImageProxyHandler::ImageProxyHandler(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context,
                                context.FindComponent<auth::OAuthConfig>())
    , http_client_(
          context.FindComponent<components::HttpClient>().GetHttpClient())
    , timeout_(std::chrono::milliseconds{config["timeout-ms"].As<int>(5000)})
    , allowed_hosts_(LoadAllowedHosts(config))
{}

std::string ImageProxyHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*ctx*/) const
{
    if (!Prologue(request)) {
        return ErrorJson("not_authenticated");
    }

    const auto& url = request.GetArg("url");
    if (url.empty()) {
        return BadRequest(request, "missing ?url=<image-url>");
    }

    const auto parsed = ParseUrl(url);
    if (!parsed || (parsed->scheme != "http" && parsed->scheme != "https")) {
        return BadRequest(request, "invalid url");
    }

    // [SF-API-12] The host allowlist is the entire SSRF defense here: only
    // Genius's own CDN hosts (or, in tests, a local stub — see
    // LoadAllowedHosts) are ever fetched, exact-match
    // (kDefaultAllowedImageHosts' own comment explains why not
    // suffix/prefix matching). This transitively rejects every
    // private/loopback/link-local/metadata IP literal an attacker could
    // put directly in ?url= (127.0.0.1, 169.254.169.254, ::1, ...) — none
    // of those are ever in the allowlist, so they fail this same check; no
    // separate IP-range parsing is needed for that case. What this does
    // NOT defend against: DNS rebinding on an already-allowlisted hostname
    // itself — not a realistic threat here since the allowlist (in
    // production) only ever contains Genius's own production domains, not
    // attacker-influenced input.
    if (!IsAllowedHost(allowed_hosts_, parsed->host)) {
        return BadRequest(request, "url host not allowlisted");
    }

    try {
        // follow_redirects(false): a redirect target could point anywhere,
        // including a host the allowlist above doesn't cover — never
        // followed. A 3xx response from the upstream is treated as a
        // failure (see the status check below), not silently chased.
        const auto response = http_client_.CreateRequest()
            .get(url)
            .timeout(timeout_)
            .retry(1)
            .follow_redirects(false)
            .perform();

        const int status = response->status_code();
        if (status >= 300 && status < 400) {
            LOG_WARNING() << "[ImageProxy] request_id=" << CurrentRequestId()
                          << " host=" << parsed->host
                          << " upstream redirected (status=" << status
                          << "), not following";
            return BadRequest(request, "upstream redirected");
        }
        if (status < 200 || status >= 300) {
            return BadGateway(request, "upstream fetch failed");
        }

        // [build fix] response->headers()["Content-Type"] (a raw string
        // literal) hits HeaderMap's compile-time PredefinedHeader
        // static_assert ("Please create a 'constexpr PredefinedHeader'...")
        // — the array-literal operator[] overload is reserved for those.
        // Wrapping in std::string{...} routes to the runtime-string
        // overload instead, same workaround internal_http.cpp already uses
        // for its own header literals.
        const std::string content_type =
            response->headers()[std::string{"Content-Type"}];
        if (!IsImageContentType(content_type)) {
            // Upstream didn't claim to be an image — refuse to relay
            // whatever it actually is. Defense in depth: even on an
            // allowlisted host, don't forward an arbitrary content-type to
            // the browser labeled (or worse, sniffed) as image content.
            return BadGateway(request, "upstream did not return an image");
        }

        auto& http_response = request.GetHttpResponse();
        http_response.SetContentType(http::ContentType(content_type));
        // [SF-API-12] Genius CDN artwork is immutable per URL (a new
        // upload gets a new URL, not an overwrite) — safe to cache
        // "forever", same reasoning handler-script/handler-vendor-vis-
        // network already use for their own content-addressed assets.
        http_response.SetHeader(std::string{"Cache-Control"},
                                 "public, max-age=31536000, immutable");
        return response->body();
    } catch (const std::exception& ex) {
        LOG_WARNING() << "[ImageProxy] request_id=" << CurrentRequestId()
                      << " host=" << parsed->host << " fetch failed: "
                      << ex.what();
        return BadGateway(request, "upstream fetch failed");
    }
}

// static
userver::yaml_config::Schema ImageProxyHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<HttpHandlerBase>(kImageProxyHandlerSchema);
}

} // namespace six_feat
