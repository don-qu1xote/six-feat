#pragma once

// [SF-SEC-01] Internal HTTP API for six-feat-auth. Not meant for external
// clients — requires the X-Internal-Secret header to match
// ENRICHMENT_INTERNAL_SECRET (see core/internal_auth.hpp, reused here as
// the shared inter-service secret for the whole internal mesh).

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::auth {

// GET /internal/key-fingerprint
// Header: X-Internal-Secret: <ENRICHMENT_INTERNAL_SECRET>
// 200: {"fingerprint": "<hex sha256, see session_crypto::KeyFingerprint>"}
// 401: {"error": "unauthorized"}
//
// Publishes a non-invertible fingerprint of this process's APP_SECRET so
// six-feat's AppSecretParityChecker can detect a mismatch without either
// side ever transmitting the secret itself.
class KeyFingerprintHandler final
    : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-key-fingerprint";

    KeyFingerprintHandler(const userver::components::ComponentConfig&  config,
                          const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const std::string shared_secret_;
    const std::string fingerprint_;
};

// GET /readyz — unauthenticated readiness probe. [SF-INF-03] Unified body
// shape (six_feat::ReadinessCheck/BuildReadinessBody, see
// libs/six-feat-common/src/http/readiness_common.hpp). This service has no
// Postgres, no internal-service dependency of its own to poll (session
// encryption is a pure function of APP_SECRET, read once at boot — it
// can't degrade at runtime the way a network dependency can), and each of
// its OAuth handlers calls the real Genius API directly per-request rather
// than through a component this handler could meaningfully probe ahead of
// time. checks{} is therefore always empty and this always reports ready —
// an honest reflection of "there is nothing here that degrades", not a
// stub left unfinished. If a genuine runtime-degradable dependency is ever
// added to this service, it belongs in checks{} here.
class ReadinessHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-readyz";

    ReadinessHandler(const userver::components::ComponentConfig&  config,
                      const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();
};

} // namespace six_feat::auth
