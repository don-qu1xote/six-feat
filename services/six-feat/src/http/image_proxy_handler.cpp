
#include "http/image_proxy_handler.hpp"

#include "core/request_id.hpp"

#include "schemas/handlers/six-feat/image_proxy_handler_schema.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <optional>
#include <string>
#include <string_view>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <utility>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

constexpr std::array<std::string_view, 2> kDefaultAllowedImageHosts = {
    "images.genius.com",
    "assets.genius.com",
};

std::string ToLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return s;
}

std::vector<std::string> LoadAllowedHosts(const yaml_config::YamlConfig& config) {
  auto hosts = config["allowed-hosts"].As<std::vector<std::string>>(std::vector<std::string>{});
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

std::optional<ParsedUrl> ParseUrl(const std::string& url) {
  const auto scheme_end = url.find("://");
  if (scheme_end == std::string::npos) return std::nullopt;

  std::string scheme = ToLower(url.substr(0, scheme_end));

  const auto host_start = scheme_end + 3;
  if (host_start >= url.size()) return std::nullopt;

  const auto authority_end = url.find_first_of("/?#", host_start);
  const std::string authority = url.substr(
      host_start,
      authority_end == std::string::npos ? std::string::npos : authority_end - host_start);
  if (authority.empty()) return std::nullopt;

  if (authority.find('@') != std::string::npos) return std::nullopt;

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

std::string ErrorJson(const std::string& code) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["error"] = code;
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

}  // namespace
ImageProxyHandler::ImageProxyHandler(const components::ComponentConfig& config,
                                     const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      timeout_(std::chrono::milliseconds{config["timeout-ms"].As<int>(5000)}),
      allowed_hosts_(LoadAllowedHosts(config)) {}

std::string ImageProxyHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                  server::request::RequestContext&) const {
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

  if (!IsAllowedHost(allowed_hosts_, parsed->host)) {
    return BadRequest(request, "url host not allowlisted");
  }

  try {
    const auto response = http_client_.CreateRequest()
                              .get(url)
                              .timeout(timeout_)
                              .retry(1)
                              .follow_redirects(false)
                              .perform();

    const int status = response->status_code();
    if (status >= 300 && status < 400) {
      LOG_WARNING() << "[ImageProxy] request_id=" << CurrentRequestId() << " host=" << parsed->host
                    << " upstream redirected (status=" << status << "), not following";
      return BadRequest(request, "upstream redirected");
    }
    if (status < 200 || status >= 300) {
      return BadGateway(request, "upstream fetch failed");
    }

    const std::string content_type = response->headers()[std::string{"Content-Type"}];
    if (!IsImageContentType(content_type)) {
      return BadGateway(request, "upstream did not return an image");
    }

    auto& http_response = request.GetHttpResponse();
    http_response.SetContentType(http::ContentType(content_type));
    http_response.SetHeader(std::string{"Cache-Control"}, "public, max-age=31536000, immutable");
    return response->body();
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[ImageProxy] request_id=" << CurrentRequestId() << " host=" << parsed->host
                  << " fetch failed: " << ex.what();
    return BadGateway(request, "upstream fetch failed");
  }
}

userver::yaml_config::Schema ImageProxyHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<HttpHandlerBase>(kImageProxyHandlerSchema);
}

}  // namespace six_feat