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

} // namespace six_feat::auth
