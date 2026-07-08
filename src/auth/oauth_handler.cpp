#include "auth/oauth_handler.hpp"
#include "auth/session_crypto.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"

#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include <chrono>
#include <cstdlib>
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

// ── URL encoding helper ────────────────────────────────────────────────────────

namespace {

std::string UrlEncode(const std::string& s) {
    std::string out;
    out.reserve(s.size() * 3);
    static const char* kHex = "0123456789ABCDEF";
    for (unsigned char c : s) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' ||
            c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += kHex[c >> 4];
            out += kHex[c & 0x0F];
        }
    }
    return out;
}

// Base64url-encode 16 bytes for state token
std::string RandomState() {
    std::array<unsigned char, 16> rand_bytes{};
    if (RAND_bytes(rand_bytes.data(), 16) != 1) {
        throw std::runtime_error("RAND_bytes failed");
    }
    // Simple hex is fine for state — just needs to be unguessable
    static const char* kHex = "0123456789abcdef";
    std::string out;
    out.reserve(32);
    for (auto b : rand_bytes) {
        out += kHex[b >> 4];
        out += kHex[b & 0x0F];
    }
    return out;
}

// A non-positive session TTL would mint cookies that are already expired
// (or expire at an undefined point due to overflow), silently breaking
// login for every user instead of failing at startup.
int RequirePositive(std::string_view param, int value) {
    if (value <= 0) {
        throw std::runtime_error(
            "oauth-config: " + std::string(param) +
            " must be a positive integer, got " + std::to_string(value));
    }
    return value;
}

// Constant-time comparison — prevents a timing side-channel from letting an
// attacker recover the CSRF state/token byte-by-byte by measuring how long
// the comparison takes to fail. std::string::operator== short-circuits on
// the first mismatching byte, which is NOT safe for comparing secrets.
bool ConstantTimeEquals(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    return CRYPTO_memcmp(a.data(), b.data(), a.size()) == 0;
}

// TTL for the short-lived OAuth state/PKCE-verifier cookies: only needed
// between /oauth/authorize and CallbackHandler completing the exchange.
constexpr std::chrono::seconds kOAuthFlowCookieTtl{300};

// ── PKCE (RFC 7636) helpers — only exercised when oauth-config.pkce-enabled=true ──

std::string Base64UrlEncode(const unsigned char* data, std::size_t len) {
    static const char* kB64Chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    out.reserve((len + 2) / 3 * 4);
    for (std::size_t i = 0; i < len; i += 3) {
        unsigned int b = static_cast<unsigned int>(data[i]) << 16;
        if (i + 1 < len) b |= static_cast<unsigned int>(data[i + 1]) << 8;
        if (i + 2 < len) b |= static_cast<unsigned int>(data[i + 2]);
        out += kB64Chars[(b >> 18) & 0x3F];
        out += kB64Chars[(b >> 12) & 0x3F];
        if (i + 1 < len) out += kB64Chars[(b >> 6) & 0x3F];
        if (i + 2 < len) out += kB64Chars[(b)      & 0x3F];
    }
    return out;
}

// code_verifier: 32 random bytes, base64url-encoded (no padding) → 43 chars,
// entirely within RFC 7636's unreserved set (ALPHA / DIGIT / "-" / "." / "_" / "~")
// and within the spec's required 43-128 length range.
std::string GenerateCodeVerifier() {
    std::array<unsigned char, 32> rand_bytes{};
    if (RAND_bytes(rand_bytes.data(), rand_bytes.size()) != 1) {
        throw std::runtime_error("RAND_bytes failed");
    }
    return Base64UrlEncode(rand_bytes.data(), rand_bytes.size());
}

// code_challenge = BASE64URL(SHA256(code_verifier)) — RFC 7636 §4.2, S256 method.
std::string ComputeCodeChallenge(const std::string& verifier) {
    std::array<unsigned char, SHA256_DIGEST_LENGTH> digest{};
    SHA256(reinterpret_cast<const unsigned char*>(verifier.data()),
           verifier.size(), digest.data());
    return Base64UrlEncode(digest.data(), digest.size());
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// OAuthConfig
// ════════════════════════════════════════════════════════════════════════════

OAuthConfig::OAuthConfig(const components::ComponentConfig&  config,
                          const components::ComponentContext& context)
    : ComponentBase(config, context),
      client_id_(config["client-id"].As<std::string>()),
      redirect_uri_(config["redirect-uri"].As<std::string>()),
      genius_base_url_(config["genius-base-url"].As<std::string>("https://api.genius.com")),
      session_ttl_days_(RequirePositive(
          "session-ttl-days", config["session-ttl-days"].As<int>(90))),
      cookie_secure_(config["cookie-secure"].As<bool>(true)),
      pkce_enabled_(config["pkce-enabled"].As<bool>(false)),
      session_key_(KeyFromEnv())
{
    // client_secret — only from env, never from yaml
    const char* secret_env = std::getenv("GENIUS_CLIENT_SECRET");
    if (!secret_env || !*secret_env)
        throw std::runtime_error(
            "GENIUS_CLIENT_SECRET env var is required for OAuth");
    client_secret_ = secret_env;

    // [ТЗ-6] Fail loudly at startup on obvious misconfiguration rather than
    // booting successfully and producing a confusing "Invalid Authorization"
    // page from Genius on the user's first login attempt. This catches the
    // single most common cause of that error: client_id/redirect_uri left
    // as unfilled placeholders, or a redirect_uri that's structurally wrong.
    if (client_id_.empty() ||
        client_id_.find("PASTE_YOUR") != std::string::npos)
        throw std::runtime_error(
            "oauth-config.client-id is empty or still a placeholder — "
            "set GENIUS_CLIENT_ID to the Client ID from "
            "https://genius.com/api-clients");

    if (redirect_uri_.empty() ||
        (redirect_uri_.rfind("http://", 0) != 0 &&
         redirect_uri_.rfind("https://", 0) != 0))
        throw std::runtime_error(
            "oauth-config.redirect-uri ('" + redirect_uri_ + "') must be an "
            "absolute http(s):// URL — set GENIUS_REDIRECT_URI");

    // Log the exact redirect_uri this service will send to Genius. Genius
    // requires the registered Redirect URI on genius.com/api-clients to
    // match this value BYTE-FOR-BYTE (scheme, host, port, trailing slash) —
    // any mismatch is the #1 cause of Genius returning "Invalid
    // Authorization" on /oauth/authorize. Compare this logged value against
    // the API Client's Redirect URI field directly.
    LOG_INFO() << "[OAuth] redirect_uri configured as: " << redirect_uri_
               << " — this MUST exactly match the Redirect URI registered "
                  "for this client_id on https://genius.com/api-clients";
}

userver::yaml_config::Schema OAuthConfig::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<ComponentBase>(R"(
type: object
description: Genius OAuth 2.0 configuration
additionalProperties: false
properties:
  client-id:
    type: string
    description: Genius API client_id
  redirect-uri:
    type: string
    description: OAuth callback URL
  genius-base-url:
    type: string
    description: Genius API base URL
    defaultDescription: https://api.genius.com
  session-ttl-days:
    type: integer
    description: Session cookie lifetime in days
    defaultDescription: 90
  cookie-secure:
    type: boolean
    description: Set Secure flag on cookies (disable for HTTP dev)
    defaultDescription: true
  pkce-enabled:
    type: boolean
    description: >-
      Enable PKCE (RFC 7636): send code_challenge/code_challenge_method on
      /oauth/authorize and code_verifier on /oauth/token. Off by default —
      Genius's OAuth docs do not document PKCE support, so this is opt-in
      until confirmed safe against production.
    defaultDescription: false
)");
}

// ════════════════════════════════════════════════════════════════════════════
// LoginHandler
// ════════════════════════════════════════════════════════════════════════════

LoginHandler::LoginHandler(const components::ComponentConfig&  config,
                            const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<OAuthConfig>())
{}

std::string LoginHandler::HandleRequestThrow(
    const server::http::HttpRequest& request,
    server::request::RequestContext& /*ctx*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    auto& response = request.GetHttpResponse();

    // Generate CSRF state token
    const std::string state = RandomState();

    // State cookie: HttpOnly, 5 minutes
    server::http::Cookie state_cookie{"six_feat_oauth_state", state};
    state_cookie.SetMaxAge(kOAuthFlowCookieTtl);
    state_cookie.SetHttpOnly();
    if (oauth_.CookieSecure()) state_cookie.SetSecure();
    state_cookie.SetSameSite("Lax");
    response.SetCookie(state_cookie);

    // [F-38] PKCE (RFC 7636) — implemented but OFF by default
    // (oauth-config.pkce-enabled). Genius's OAuth documentation
    // (https://docs.genius.com) only specifies the classic Authorization Code
    // flow and does not document a code_challenge/code_verifier/
    // code_challenge_method parameter on /oauth/authorize or /oauth/token.
    // Sending it risks Genius silently ignoring it (no benefit) or
    // hard-rejecting the whole authorize request as malformed (breaking login
    // for every user) — and we have no sandbox to verify which without
    // risking production. Keep default-off until Genius documents support;
    // operators who've confirmed it works can flip pkce-enabled: true.
    std::string pkce_query;
    if (oauth_.PkceEnabled()) {
        const std::string verifier  = GenerateCodeVerifier();
        const std::string challenge = ComputeCodeChallenge(verifier);

        // Verifier cookie: HttpOnly, same 5-minute TTL as the state cookie —
        // both are only needed until CallbackHandler completes the exchange.
        server::http::Cookie verifier_cookie{"six_feat_pkce_verifier", verifier};
        verifier_cookie.SetMaxAge(kOAuthFlowCookieTtl);
        verifier_cookie.SetHttpOnly();
        if (oauth_.CookieSecure()) verifier_cookie.SetSecure();
        verifier_cookie.SetSameSite("Lax");
        response.SetCookie(verifier_cookie);

        pkce_query = "&code_challenge=" + UrlEncode(challenge) +
                     "&code_challenge_method=S256";
    }

    // Build redirect URL
    const std::string redirect =
        oauth_.GeniusBaseUrl() + "/oauth/authorize"
        "?client_id=" + UrlEncode(oauth_.ClientId()) +
        "&redirect_uri=" + UrlEncode(oauth_.RedirectUri()) +
        "&scope=me"
        "&response_type=code"
        "&state=" + state +
        pkce_query;

    // [ТЗ-6] Log the exact URL sent to Genius. If users hit "Invalid
    // Authorization" on this page, the redirect_uri here must match the
    // Redirect URI registered for this client_id on genius.com/api-clients
    // byte-for-byte (scheme, host, port, trailing slash).
    LOG_DEBUG() << "[OAuth] redirecting to: " << redirect;

    response.SetStatus(server::http::HttpStatus::kFound);
    response.SetHeader(std::string_view("Location"), redirect);
    return "";
}

// ════════════════════════════════════════════════════════════════════════════
// CallbackHandler
// ════════════════════════════════════════════════════════════════════════════

CallbackHandler::CallbackHandler(const components::ComponentConfig&  config,
                                  const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<OAuthConfig>()),
      http_client_(
          context.FindComponent<components::HttpClient>().GetHttpClient())
{}

std::string CallbackHandler::HandleRequestThrow(
    const server::http::HttpRequest& request,
    server::request::RequestContext& /*ctx*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    using HttpStatus = server::http::HttpStatus;
    auto& response = request.GetHttpResponse();

    // 1. Verify CSRF state (constant-time — a data-dependent early-exit
    // comparison here would let an attacker recover the expected state
    // byte-by-byte via a timing side-channel).
    const std::string& state_param  = request.GetArg("state");
    const std::string state_cookie = request.GetCookie("six_feat_oauth_state");
    if (state_param.empty() || state_cookie.empty() ||
        !ConstantTimeEquals(state_param, state_cookie)) {
        response.SetStatus(HttpStatus::kBadRequest);
        return "Invalid state parameter (CSRF check failed)";
    }

    // 2. Check for error (user denied)
    const std::string& error = request.GetArg("error");
    if (!error.empty()) {
        response.SetStatus(HttpStatus::kFound);
        response.SetHeader(std::string_view("Location"), "/?auth=denied");
        return "";
    }

    // 3. Get code
    const std::string& code = request.GetArg("code");
    if (code.empty()) {
        response.SetStatus(HttpStatus::kBadRequest);
        return "Missing code parameter";
    }

    // 3b. [F-38] PKCE — read the verifier cookie set by LoginHandler. Empty
    // when oauth-config.pkce-enabled=false, since LoginHandler never sets it
    // in that case; ExchangeCode omits code_verifier from the token request
    // when this is empty, so the exchange is byte-for-byte unchanged with the
    // flag off.
    const std::string code_verifier = request.GetCookie("six_feat_pkce_verifier");

    // 4. Exchange code for access_token
    std::string access_token, genius_name;
    try {
        auto [tok, name] = ExchangeCode(code, code_verifier);
        access_token = std::move(tok);
        genius_name  = std::move(name);
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

    // 5. Encrypt token into cookie
    using SC = std::chrono::system_clock;
    const auto now_unix = static_cast<std::int64_t>(
        std::chrono::duration_cast<std::chrono::seconds>(
            SC::now().time_since_epoch()).count());
    const std::int64_t exp = now_unix + static_cast<std::int64_t>(oauth_.SessionTtlDays()) * 86400LL;

    std::string cookie_value;
    try {
        cookie_value = Encrypt(access_token, exp, oauth_.SessionKey(), genius_name);
    } catch (const std::exception& ex) {
        LOG_ERROR() << "[OAuth] Encrypt failed: " << ex.what();
        response.SetStatus(HttpStatus::kInternalServerError);
        return "Session encryption error";
    }

    // 6. Set session cookie
    server::http::Cookie session_cookie{"six_feat_session", cookie_value};
    session_cookie.SetMaxAge(std::chrono::seconds{
        static_cast<long>(oauth_.SessionTtlDays()) * 86400L});
    session_cookie.SetHttpOnly();
    if (oauth_.CookieSecure()) session_cookie.SetSecure();
    session_cookie.SetSameSite("Strict");
    session_cookie.SetPath("/");
    response.SetCookie(session_cookie);

    // 6b. [F-38] Double-submit CSRF token for POST /auth/logout. Deliberately
    // NOT HttpOnly — the front end must read it via document.cookie and echo
    // it back in the X-CSRF-Token header; a cross-site form/img can forge the
    // POST but cannot read this cookie's value to put in that header.
    const std::string csrf_token = RandomState();
    server::http::Cookie csrf_cookie{"six_feat_csrf", csrf_token};
    csrf_cookie.SetMaxAge(std::chrono::seconds{
        static_cast<long>(oauth_.SessionTtlDays()) * 86400L});
    if (oauth_.CookieSecure()) csrf_cookie.SetSecure();
    csrf_cookie.SetSameSite("Strict");
    csrf_cookie.SetPath("/");
    response.SetCookie(csrf_cookie);

    // 7. Clear state cookie
    server::http::Cookie clear_state{"six_feat_oauth_state", ""};
    clear_state.SetMaxAge(std::chrono::seconds{0});
    clear_state.SetHttpOnly();
    response.SetCookie(clear_state);

    // 7b. [F-38] Clear PKCE verifier cookie after a successful exchange
    // (no-op when oauth-config.pkce-enabled=false — cookie was never set).
    if (!code_verifier.empty()) {
        server::http::Cookie clear_verifier{"six_feat_pkce_verifier", ""};
        clear_verifier.SetMaxAge(std::chrono::seconds{0});
        clear_verifier.SetHttpOnly();
        response.SetCookie(clear_verifier);
    }

    // 8. Redirect to home
    response.SetStatus(HttpStatus::kFound);
    response.SetHeader(std::string_view("Location"), "/");
    return "";
}

std::pair<std::string, std::string> CallbackHandler::ExchangeCode(
    const std::string& code, const std::string& code_verifier) const
{
    std::string body =
        "code="           + UrlEncode(code) +
        "&client_id="     + UrlEncode(oauth_.ClientId()) +
        "&client_secret=" + UrlEncode(oauth_.ClientSecret()) +
        "&redirect_uri="  + UrlEncode(oauth_.RedirectUri()) +
        "&grant_type=authorization_code";

    // [F-38] PKCE — only appended when LoginHandler actually challenged with
    // code_challenge (oauth-config.pkce-enabled=true), keeping the request
    // byte-for-byte identical to before when the flag is off.
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

    const auto json  = formats::json::FromString(resp->body());
    const auto token = json["access_token"].As<std::string>("");
    if (token.empty())
        throw std::runtime_error("access_token missing in Genius response");

    // Try to get username from the token response or fetch it separately
    std::string name;
    try {
        name = FetchGeniusName(token);
    } catch (...) {
        // Non-critical — name is cosmetic only
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

// ════════════════════════════════════════════════════════════════════════════
// LogoutHandler
// ════════════════════════════════════════════════════════════════════════════

LogoutHandler::LogoutHandler(const components::ComponentConfig&  config,
                              const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<OAuthConfig>())
{}

std::string LogoutHandler::HandleRequestThrow(
    const server::http::HttpRequest& request,
    server::request::RequestContext& /*ctx*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    auto& response = request.GetHttpResponse();

    // [F-38] logout is now routed as POST-only (see static_config.yaml), so a
    // bare <img src="/auth/logout"> or a prefetched link can no longer fire
    // it. As defense in depth, also require a double-submit CSRF token when
    // there's an active session to protect — the six_feat_session cookie is
    // SameSite=Strict already, but this stops logout via a same-site HTML
    // form/auto-submit trick too. Skip the check for already-anonymous
    // requests: there is no session to steal a logout against, so this stays
    // a safe no-op/idempotent clear (e.g. a stray double-click on "Sign out").
    const std::string session_cookie_in = request.GetCookie("six_feat_session");
    if (!session_cookie_in.empty()) {
        const std::string& csrf_header =
            request.GetHeader(std::string_view("X-CSRF-Token"));
        const std::string csrf_cookie = request.GetCookie("six_feat_csrf");
        if (csrf_cookie.empty() || csrf_header.empty() ||
            !ConstantTimeEquals(csrf_header, csrf_cookie)) {
            response.SetStatus(server::http::HttpStatus::kForbidden);
            return "Invalid or missing CSRF token";
        }
    }

    // Clear session cookie (max_age=0 → browser deletes immediately)
    server::http::Cookie session_cookie{"six_feat_session", ""};
    session_cookie.SetMaxAge(std::chrono::seconds{0});
    session_cookie.SetHttpOnly();
    if (oauth_.CookieSecure()) session_cookie.SetSecure();
    session_cookie.SetSameSite("Strict");
    session_cookie.SetPath("/");
    response.SetCookie(session_cookie);

    // Clear CSRF cookie alongside the session it protects.
    server::http::Cookie csrf_cookie{"six_feat_csrf", ""};
    csrf_cookie.SetMaxAge(std::chrono::seconds{0});
    csrf_cookie.SetSameSite("Strict");
    csrf_cookie.SetPath("/");
    response.SetCookie(csrf_cookie);

    response.SetStatus(server::http::HttpStatus::kFound);
    response.SetHeader(std::string_view("Location"), "/");
    return "";
}

// ════════════════════════════════════════════════════════════════════════════
// MeHandler — /auth/me
// ════════════════════════════════════════════════════════════════════════════

MeHandler::MeHandler(const components::ComponentConfig&  config,
                      const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<OAuthConfig>())
{}

std::string MeHandler::HandleRequestThrow(
    const server::http::HttpRequest& request,
    server::request::RequestContext& /*ctx*/) const
{
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

} // namespace six_feat::auth
