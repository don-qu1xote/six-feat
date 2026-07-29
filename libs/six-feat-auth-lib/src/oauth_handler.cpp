#include "schemas/handlers/shared/oauth_handler_schema.hpp"

#include <chrono>
#include <cstdlib>
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <stdexcept>
#include <userver/clients/http/client.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_response.hpp>
#include <userver/server/http/http_status.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::auth {

using namespace userver;

namespace {

std::string UrlEncode(const std::string& s) {
  std::string out;
  out.reserve(s.size() * 3);
  static const char* kHex = "0123456789ABCDEF";
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

std::string RandomState() {
  std::array<unsigned char, 16> rand_bytes{};
  if (RAND_bytes(rand_bytes.data(), 16) != 1) {
    throw std::runtime_error("RAND_bytes failed");
  }
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.reserve(32);
  for (auto b : rand_bytes) {
    out += kHex[b >> 4];
    out += kHex[b & 0x0F];
  }
  return out;
}

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("oauth-config: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

bool ConstantTimeEquals(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  return CRYPTO_memcmp(a.data(), b.data(), a.size()) == 0;
}

constexpr std::chrono::seconds kOAuthFlowCookieTtl{300};

std::string Base64UrlEncode(const unsigned char* data, std::size_t len) {
  static const char* kB64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  for (std::size_t i = 0; i < len; i += 3) {
    unsigned int b = static_cast<unsigned int>(data[i]) << 16;
    if (i + 1 < len) b |= static_cast<unsigned int>(data[i + 1]) << 8;
    if (i + 2 < len) b |= static_cast<unsigned int>(data[i + 2]);
    out += kB64Chars[(b >> 18) & 0x3F];
    out += kB64Chars[(b >> 12) & 0x3F];
    if (i + 1 < len) out += kB64Chars[(b >> 6) & 0x3F];
    if (i + 2 < len) out += kB64Chars[b & 0x3F];
  }
  return out;
}

std::string GenerateCodeVerifier() {
  std::array<unsigned char, 32> rand_bytes{};
  if (RAND_bytes(rand_bytes.data(), static_cast<int>(rand_bytes.size())) != 1) {
    throw std::runtime_error("RAND_bytes failed");
  }
  return Base64UrlEncode(rand_bytes.data(), rand_bytes.size());
}

std::string ComputeCodeChallenge(const std::string& verifier) {
  std::array<unsigned char, SHA256_DIGEST_LENGTH> digest{};
  SHA256(reinterpret_cast<const unsigned char*>(verifier.data()), verifier.size(), digest.data());
  return Base64UrlEncode(digest.data(), digest.size());
}

}  // namespace

OAuthConfig::OAuthConfig(const components::ComponentConfig& config,
                         const components::ComponentContext& context)
    : ComponentBase(config, context),
      client_id_(config["client-id"].As<std::string>()),
      redirect_uri_(config["redirect-uri"].As<std::string>()),
      genius_base_url_(config["genius-base-url"].As<std::string>("https://api.genius.com")),
      session_ttl_days_(
          RequirePositive("session-ttl-days", config["session-ttl-days"].As<int>(90))),
      cookie_secure_(config["cookie-secure"].As<bool>(true)),
      pkce_enabled_(config["pkce-enabled"].As<bool>(false)),
      session_key_(KeyFromEnv()) {
  const char* secret_env = std::getenv("GENIUS_CLIENT_SECRET");
  if (!secret_env || !*secret_env)
    throw std::runtime_error("GENIUS_CLIENT_SECRET env var is required for OAuth");
  client_secret_ = secret_env;

  if (client_id_.empty() || client_id_.find("PASTE_YOUR") != std::string::npos)
    throw std::runtime_error(
        "oauth-config.client-id is empty or still a placeholder — "
        "set GENIUS_CLIENT_ID to the Client ID from "
        "https://genius.com/api-clients");

  if (redirect_uri_.empty() ||
      (redirect_uri_.rfind("http://", 0) != 0 && redirect_uri_.rfind("https://", 0) != 0))
    throw std::runtime_error("oauth-config.redirect-uri ('" + redirect_uri_ +
                             "') must be an "
                             "absolute http(s):// URL — set GENIUS_REDIRECT_URI");

  LOG_INFO() << "[OAuth] redirect_uri configured as: " << redirect_uri_
             << " — this MUST exactly match the Redirect URI registered "
                "for this client_id on https://genius.com/api-clients";
}

userver::yaml_config::Schema OAuthConfig::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<ComponentBase>(kOAuthHandlerSchema);
}

LoginHandler::LoginHandler(const components::ComponentConfig& config,
                           const components::ComponentContext& context)
    : HttpHandlerBase(config, context), oauth_(context.FindComponent<OAuthConfig>()) {}

std::string LoginHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                             server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();

  const std::string state = RandomState();

  server::http::Cookie state_cookie{"six_feat_oauth_state", state};
  state_cookie.SetMaxAge(kOAuthFlowCookieTtl);
  state_cookie.SetHttpOnly();
  if (oauth_.CookieSecure()) state_cookie.SetSecure();
  state_cookie.SetSameSite("Lax");
  state_cookie.SetPath("/");
  response.SetCookie(state_cookie);

  std::string pkce_query;
  if (oauth_.PkceEnabled()) {
    const std::string verifier = GenerateCodeVerifier();
    const std::string challenge = ComputeCodeChallenge(verifier);

    server::http::Cookie verifier_cookie{"six_feat_pkce_verifier", verifier};
    verifier_cookie.SetMaxAge(kOAuthFlowCookieTtl);
    verifier_cookie.SetHttpOnly();
    if (oauth_.CookieSecure()) verifier_cookie.SetSecure();
    verifier_cookie.SetSameSite("Lax");
    verifier_cookie.SetPath("/");
    response.SetCookie(verifier_cookie);

    pkce_query = "&code_challenge=" + UrlEncode(challenge) + "&code_challenge_method=S256";
  }

  const std::string redirect = oauth_.GeniusBaseUrl() +
                               "/oauth/authorize"
                               "?client_id=" +
                               UrlEncode(oauth_.ClientId()) +
                               "&redirect_uri=" + UrlEncode(oauth_.RedirectUri()) +
                               "&scope=me"
                               "&response_type=code"
                               "&state=" +
                               state + pkce_query;

  LOG_DEBUG() << "[OAuth] redirecting to: " << redirect;

  response.SetStatus(server::http::HttpStatus::kFound);
  response.SetHeader(std::string_view("Location"), redirect);
  return "";
}

CallbackHandler::CallbackHandler(const components::ComponentConfig& config,
                                 const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<OAuthConfig>()),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()) {}

std::string CallbackHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  using HttpStatus = server::http::HttpStatus;
  auto& response = request.GetHttpResponse();

  const std::string& state_param = request.GetArg("state");
  const std::string state_cookie = request.GetCookie("six_feat_oauth_state");
  if (state_param.empty() || state_cookie.empty() ||
      !ConstantTimeEquals(state_param, state_cookie)) {
    response.SetStatus(HttpStatus::kBadRequest);
    return "Invalid state parameter (CSRF check failed)";
  }

  const std::string& error = request.GetArg("error");
  if (!error.empty()) {
    response.SetStatus(HttpStatus::kFound);
    response.SetHeader(std::string_view("Location"), "/?auth=denied");
    return "";
  }

  const std::string& code = request.GetArg("code");
  if (code.empty()) {
    response.SetStatus(HttpStatus::kBadRequest);
    return "Missing code parameter";
  }

  const std::string code_verifier = request.GetCookie("six_feat_pkce_verifier");

  std::string access_token, genius_name;
  try {
    auto [tok, name] = ExchangeCode(code, code_verifier);
    access_token = std::move(tok);
    genius_name = std::move(name);
  } catch (const std::exception& ex) {
    LOG_ERROR() << "[OAuth] Token exchange failed: " << ex.what();
    if (!code_verifier.empty()) {
      server::http::Cookie clear_verifier{"six_feat_pkce_verifier", ""};
      clear_verifier.SetMaxAge(std::chrono::seconds{0});
      clear_verifier.SetHttpOnly();
      response.SetCookie(clear_verifier);
    }
    response.SetStatus(HttpStatus::kFound);
    response.SetHeader(std::string_view("Location"), "/?auth=error");
    return "";
  }

  using SC = std::chrono::system_clock;
  const auto now_unix = static_cast<std::int64_t>(
      std::chrono::duration_cast<std::chrono::seconds>(SC::now().time_since_epoch()).count());
  const std::int64_t exp = now_unix + static_cast<std::int64_t>(oauth_.SessionTtlDays()) * 86400LL;

  std::string cookie_value;
  try {
    cookie_value = Encrypt(access_token, exp, oauth_.SessionKey(), genius_name);
  } catch (const std::exception& ex) {
    LOG_ERROR() << "[OAuth] Encrypt failed: " << ex.what();
    response.SetStatus(HttpStatus::kInternalServerError);
    return "Session encryption error";
  }

  server::http::Cookie session_cookie{"six_feat_session", cookie_value};
  session_cookie.SetMaxAge(
      std::chrono::seconds{static_cast<long>(oauth_.SessionTtlDays()) * 86400L});
  session_cookie.SetHttpOnly();
  if (oauth_.CookieSecure()) session_cookie.SetSecure();
  session_cookie.SetSameSite("Lax");
  session_cookie.SetPath("/");
  response.SetCookie(session_cookie);

  const std::string csrf_token = RandomState();
  server::http::Cookie csrf_cookie{"six_feat_csrf", csrf_token};
  csrf_cookie.SetMaxAge(std::chrono::seconds{static_cast<long>(oauth_.SessionTtlDays()) * 86400L});
  if (oauth_.CookieSecure()) csrf_cookie.SetSecure();
  csrf_cookie.SetSameSite("Strict");
  csrf_cookie.SetPath("/");
  response.SetCookie(csrf_cookie);

  server::http::Cookie clear_state{"six_feat_oauth_state", ""};
  clear_state.SetMaxAge(std::chrono::seconds{0});
  clear_state.SetHttpOnly();
  clear_state.SetPath("/");
  response.SetCookie(clear_state);

  if (!code_verifier.empty()) {
    server::http::Cookie clear_verifier{"six_feat_pkce_verifier", ""};
    clear_verifier.SetMaxAge(std::chrono::seconds{0});
    clear_verifier.SetHttpOnly();
    clear_verifier.SetPath("/");
    response.SetCookie(clear_verifier);
  }

  response.SetStatus(HttpStatus::kFound);
  response.SetHeader(std::string_view("Location"), "/");
  return "";
}

std::pair<std::string, std::string> CallbackHandler::ExchangeCode(
    const std::string& code, const std::string& code_verifier) const {
  std::string body = "code=" + UrlEncode(code) + "&client_id=" + UrlEncode(oauth_.ClientId()) +
                     "&client_secret=" + UrlEncode(oauth_.ClientSecret()) +
                     "&redirect_uri=" + UrlEncode(oauth_.RedirectUri()) +
                     "&grant_type=authorization_code";

  if (!code_verifier.empty()) {
    body += "&code_verifier=" + UrlEncode(code_verifier);
  }

  const auto resp = http_client_.CreateRequest()
                        .post(oauth_.GeniusBaseUrl() + "/oauth/token")
                        .data(body)
                        .headers({{"Content-Type", "application/x-www-form-urlencoded"}})
                        .timeout(std::chrono::seconds{10})
                        .retry(0)
                        .perform();

  if (resp->status_code() != 200)
    throw std::runtime_error("Genius token endpoint returned HTTP " +
                             std::to_string(resp->status_code()));

  const auto json = formats::json::FromString(resp->body());
  auto token = json["access_token"].As<std::string>("");
  if (token.empty()) throw std::runtime_error("access_token missing in Genius response");

  std::string name;
  try {
    name = FetchGeniusName(token);
  } catch (...) {
  }

  return {token, name};
}

std::string CallbackHandler::FetchGeniusName(const std::string& access_token) const {
  const auto resp = http_client_.CreateRequest()
                        .get(oauth_.GeniusBaseUrl() + "/account?text_format=plain")
                        .headers({{"Authorization", "Bearer " + access_token}})
                        .timeout(std::chrono::seconds{5})
                        .retry(0)
                        .perform();

  if (resp->status_code() != 200) return "";

  const auto json = formats::json::FromString(resp->body());
  return json["response"]["user"]["name"].As<std::string>("");
}

LogoutHandler::LogoutHandler(const components::ComponentConfig& config,
                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context), oauth_(context.FindComponent<OAuthConfig>()) {}

std::string LogoutHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                              server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();

  const std::string session_cookie_in = request.GetCookie("six_feat_session");
  if (!session_cookie_in.empty()) {
    const std::string& csrf_header = request.GetHeader(std::string_view("X-CSRF-Token"));
    const std::string csrf_cookie = request.GetCookie("six_feat_csrf");
    if (csrf_cookie.empty() || csrf_header.empty() ||
        !ConstantTimeEquals(csrf_header, csrf_cookie)) {
      response.SetStatus(server::http::HttpStatus::kForbidden);
      return "Invalid or missing CSRF token";
    }
  }

  server::http::Cookie session_cookie{"six_feat_session", ""};
  session_cookie.SetMaxAge(std::chrono::seconds{0});
  session_cookie.SetHttpOnly();
  if (oauth_.CookieSecure()) session_cookie.SetSecure();
  session_cookie.SetSameSite("Lax");
  session_cookie.SetPath("/");
  response.SetCookie(session_cookie);

  server::http::Cookie csrf_cookie{"six_feat_csrf", ""};
  csrf_cookie.SetMaxAge(std::chrono::seconds{0});
  csrf_cookie.SetSameSite("Strict");
  csrf_cookie.SetPath("/");
  response.SetCookie(csrf_cookie);

  response.SetStatus(server::http::HttpStatus::kFound);
  response.SetHeader(std::string_view("Location"), "/");
  return "";
}

MeHandler::MeHandler(const components::ComponentConfig& config,
                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context), oauth_(context.FindComponent<OAuthConfig>()) {}

std::string MeHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                          server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetHeader(std::string_view("Content-Type"), "application/json");

  const std::string cookie = request.GetCookie("six_feat_session");
  if (!cookie.empty()) {
    const auto session = Decrypt(cookie, oauth_.SessionKey());
    if (session) {
      formats::json::ValueBuilder b(formats::json::Type::kObject);
      b["authenticated"] = true;
      b["name"] = session->name.empty() ? "Genius User" : session->name;
      return formats::json::ToString(b.ExtractValue());
    }
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["authenticated"] = false;
  return formats::json::ToString(b.ExtractValue());
}

}  // namespace six_feat::auth