#include "settings_handler.hpp"

#include "schemas/handlers/six-feat/settings_disconnect_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_enrichment_enabled_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_genius_connect_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_genius_link_start_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_status_handler_schema.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <openssl/rand.h>
#include <six-feat-auth-lib/user_identity.hpp>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <string>
#include <unordered_map>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <variant>

#include "token_router.hpp"

namespace six_feat {

using namespace userver;

namespace {

constexpr std::int64_t kFarFutureSeconds = 10LL * 365 * 24 * 3600;

std::int64_t NowUnix() {
  return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count());
}

std::string GeniusLinkUrlEncode(const std::string& s) {
  std::string out;
  out.reserve(s.size() * 3);
  static constexpr std::string_view kHex{"0123456789ABCDEF"};
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
        c == '_' || c == '.' || c == '~') {
      out += static_cast<char>(c);
    } else {
      out += '%';
      out += kHex[c >> 4];
      out += kHex[c & 0x0F];
    }
  }
  return out;
}

std::string GeniusLinkRandomState() {
  std::array<unsigned char, 16> rand_bytes{};
  if (RAND_bytes(rand_bytes.data(), 16) != 1) {
    throw std::runtime_error("RAND_bytes failed");
  }
  static constexpr std::string_view kHex{"0123456789abcdef"};
  std::string out;
  out.reserve(32);
  for (auto b : rand_bytes) {
    out += kHex[b >> 4];
    out += kHex[b & 0x0F];
  }
  return out;
}

}  // namespace

SettingsStatusHandler::SettingsStatusHandler(const components::ComponentConfig& config,
                                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()),
      parity_checker_(context.FindComponent<AppSecretParityChecker>()) {}

std::string SettingsStatusHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                      server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    if (parity_checker_.GetStatus() == AppSecretParityChecker::Status::kMismatch) {
      response.SetStatus(server::http::HttpStatus::kServiceUnavailable);
      formats::json::ValueBuilder b(formats::json::Type::kObject);
      b["error"] = std::string{"backend_misconfigured"};
      b["detail"] = std::string{
          "six-feat and six-feat-auth have different APP_SECRET values — sessions minted by "
          "one can't be read by the other. Restart both with the same APP_SECRET."};
      return formats::json::ToString(b.ExtractValue());
    }
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const auto user_id = auth::SessionUserId(*session);
  const bool genius_connected = user_provider_tokens_.Get(user_id, "genius").has_value();

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  formats::json::ValueBuilder genius(formats::json::Type::kObject);
  genius["connected"] = genius_connected;
  b["genius"] = std::move(genius);
  b["enrichment_enabled"] = user_provider_tokens_.GetEnrichmentEnabled(user_id);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsStatusHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kSettingsStatusHandlerSchema);
}

SettingsGeniusConnectHandler::SettingsGeniusConnectHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsGeniusConnectHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  std::string token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    token = body["token"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "body must be JSON with a string token");
  }
  if (token.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request, server::http::HttpStatus::kBadRequest, "token is required");
  }

  user_provider_tokens_.Connect(
      auth::SessionUserId(*session), "genius", token, NowUnix() + kFarFutureSeconds);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["provider"] = std::string{"genius"};
  b["connected"] = true;
  response.SetStatus(server::http::HttpStatus::kOk);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsGeniusConnectHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsGeniusConnectHandlerSchema);
}

SettingsDisconnectHandler::SettingsDisconnectHandler(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsDisconnectHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                          server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const std::string& provider = request.GetArg("provider");
  if (provider != "genius") {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "?provider= must be 'genius'");
  }

  const bool disconnected =
      user_provider_tokens_.Disconnect(auth::SessionUserId(*session), provider);
  if (!disconnected) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return BuildProblemJson(request, server::http::HttpStatus::kNotFound, "not_connected");
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["provider"] = provider;
  b["connected"] = false;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsDisconnectHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsDisconnectHandlerSchema);
}

SettingsEnrichmentEnabledHandler::SettingsEnrichmentEnabledHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsEnrichmentEnabledHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  bool enabled = false;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    if (!body.HasMember("enabled")) throw std::runtime_error("missing enabled");
    enabled = body["enabled"].As<bool>();
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "body must be JSON with a boolean enabled");
  }

  const auto user_id = auth::SessionUserId(*session);
  user_provider_tokens_.SetEnrichmentEnabled(user_id, enabled);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["enrichment_enabled"] = enabled;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsEnrichmentEnabledHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsEnrichmentEnabledHandlerSchema);
}

SettingsGeniusLinkStartHandler::SettingsGeniusLinkStartHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context), oauth_(context.FindComponent<auth::OAuthConfig>()) {}

std::string SettingsGeniusLinkStartHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    response.SetStatus(server::http::HttpStatus::kFound);
    response.SetHeader(std::string_view("Location"), "/");
    return "";
  }

  const std::string state = std::string{"link:"} + GeniusLinkRandomState();

  server::http::Cookie state_cookie{"six_feat_oauth_state", state};
  state_cookie.SetMaxAge(std::chrono::seconds{300});
  state_cookie.SetHttpOnly();
  if (oauth_.CookieSecure()) state_cookie.SetSecure();
  state_cookie.SetSameSite("Lax");
  state_cookie.SetPath("/");
  response.SetCookie(state_cookie);

  const std::string redirect = oauth_.GeniusBaseUrl() +
                               "/oauth/authorize"
                               "?client_id=" +
                               GeniusLinkUrlEncode(oauth_.ClientId()) +
                               "&redirect_uri=" + GeniusLinkUrlEncode(oauth_.RedirectUri()) +
                               "&scope=me"
                               "&response_type=code"
                               "&state=" +
                               GeniusLinkUrlEncode(state);

  response.SetStatus(server::http::HttpStatus::kFound);
  response.SetHeader(std::string_view("Location"), redirect);
  return "";
}

yaml_config::Schema SettingsGeniusLinkStartHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsGeniusLinkStartHandlerSchema);
}

}  // namespace six_feat
