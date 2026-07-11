#pragma once

// ════════════════════════════════════════════════════════════════════════════
// app_secret_parity_checker.hpp  —  SF-SEC-01
//
// six_feat decrypts the six_feat_session cookie LOCALLY with its own
// APP_SECRET (src/auth/token_router.hpp) — no HTTP call to six-feat-auth on
// every request. That's fast, but it means an APP_SECRET rotated/typo'd on
// only one of the two services previously surfaced as nothing more than a
// silent 401 on every session-authenticated request: no config validation,
// no readiness signal, nothing actionable in the logs.
//
// AppSecretParityChecker closes that gap without adding any per-request
// coupling: it periodically compares a non-invertible fingerprint of this
// process's APP_SECRET (session_crypto::KeyFingerprint) against the one
// six-feat-auth publishes at GET /internal/key-fingerprint — the secret
// itself never crosses the network. A mismatch is logged loudly (once, on
// the transition) and reported by ReadinessHandler's "app_secret_parity"
// check, which flips /readyz to 503. six-feat-auth being merely
// unreachable does NOT fail readiness — same soft-dependency posture
// already used for genius-gateway/enrichment.
// ════════════════════════════════════════════════════════════════════════════

#include <atomic>
#include <chrono>
#include <string>
#include <string_view>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class AppSecretParityChecker final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "app-secret-parity-checker";

    enum class Status {
        kUnknown,      // no check has completed yet
        kOk,           // fingerprints matched on the last check
        kMismatch,     // fingerprints differed on the last check
        kUnreachable,  // six-feat-auth didn't answer (network error / non-2xx)
    };

    static std::string_view ToString(Status status);

    AppSecretParityChecker(const userver::components::ComponentConfig&  config,
                          const userver::components::ComponentContext& context);

    ~AppSecretParityChecker() override;

    void OnAllComponentsLoaded() override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // Cheap, non-blocking — reads the last-known status from the background
    // check loop. Used by ReadinessHandler on every /readyz call.
    Status GetStatus() const;

private:
    // Performs one fingerprint comparison against six-feat-auth and updates
    // status_, logging on any status transition.
    void PerformCheck();
    void CheckLoop();

    userver::clients::http::Client&  http_client_;
    const std::string                auth_base_url_;
    const std::string                shared_secret_;
    const std::chrono::milliseconds  timeout_;
    const std::chrono::milliseconds  check_interval_;
    const std::string                own_fingerprint_;

    userver::engine::TaskProcessor&  fs_tp_;

    std::atomic<Status>              status_{Status::kUnknown};
    userver::engine::TaskWithResult<void> check_task_;
};

} // namespace six_feat
