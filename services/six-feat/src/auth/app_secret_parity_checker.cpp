#include "auth/app_secret_parity_checker.hpp"

#include "schemas/components/app_secret_parity_checker_schema.hpp"

#include <six-feat-auth-lib/session_crypto.hpp>
#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/internal_http.hpp>
#include <stdexcept>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <utility>

namespace six_feat {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("app-secret-parity-checker: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

}  // namespace
std::string_view AppSecretParityChecker::ToString(Status status) {
  switch (status) {
    case Status::kOk:
      return "ok";
    case Status::kMismatch:
      return "mismatch";
    case Status::kUnreachable:
      return "unreachable";
    case Status::kUnknown:
      break;
  }
  return "unknown";
}

AppSecretParityChecker::AppSecretParityChecker(const components::ComponentConfig& config,
                                               const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      auth_base_url_(config["auth-base-url"].As<std::string>()),
      shared_secret_(internal_api::SharedSecretFromEnv()),
      timeout_(std::chrono::milliseconds{
          RequirePositive("timeout-ms", config["timeout-ms"].As<int>(3000))}),
      check_interval_(std::chrono::milliseconds{
          RequirePositive("check-interval-ms", config["check-interval-ms"].As<int>(30000))}),
      own_fingerprint_(auth::KeyFingerprint(auth::KeyFromEnv())),
      fs_tp_(context.GetTaskProcessor("fs-task-processor")) {}

AppSecretParityChecker::~AppSecretParityChecker() {
  if (check_task_.IsValid()) {
    check_task_.RequestCancel();
    check_task_.Wait();
  }
}

void AppSecretParityChecker::OnAllComponentsLoaded() {
  PerformCheck();

  check_task_ = utils::Async(fs_tp_, "app-secret-parity-check", [this] { CheckLoop(); });
}

AppSecretParityChecker::Status AppSecretParityChecker::GetStatus() const {
  return status_.load();
}

void AppSecretParityChecker::PerformCheck() {
  Status new_status = Status::kUnreachable;
  std::string peer_fingerprint;

  try {
    const auto resp = internal_http::Get(
        http_client_, auth_base_url_ + "/internal/key-fingerprint", shared_secret_, timeout_);

    if (resp.status_code < 200 || resp.status_code >= 300) {
      LOG_WARNING() << "[AppSecretParityChecker] six-feat-auth "
                       "returned HTTP "
                    << resp.status_code << " for /internal/key-fingerprint";
    } else {
      peer_fingerprint = formats::json::FromString(resp.body)["fingerprint"].As<std::string>("");
      new_status = (!peer_fingerprint.empty() && peer_fingerprint == own_fingerprint_)
                       ? Status::kOk
                       : Status::kMismatch;
    }
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[AppSecretParityChecker] could not reach "
                     "six-feat-auth to verify APP_SECRET parity: "
                  << ex.what();
  }

  const Status prev = status_.exchange(new_status);
  if (new_status == prev) return;

  if (new_status == Status::kMismatch) {
    LOG_ERROR() << "[AppSecretParityChecker] APP_SECRET MISMATCH between "
                   "six_feat and six-feat-auth — every session minted "
                   "by six-feat-auth will silently fail to decrypt here "
                   "(401 not_authenticated for every user). "
                   "own_fingerprint="
                << own_fingerprint_
                << " auth_fingerprint=" << (peer_fingerprint.empty() ? "<empty>" : peer_fingerprint)
                << " — verify APP_SECRET is identical on both services.";
  } else if (new_status == Status::kOk) {
    LOG_INFO() << "[AppSecretParityChecker] APP_SECRET parity confirmed "
                  "with six-feat-auth"
               << (prev == Status::kMismatch ? " (recovered from a prior mismatch)" : "") << ".";
  }
}

void AppSecretParityChecker::CheckLoop() {
  while (!engine::current_task::ShouldCancel()) {
    engine::InterruptibleSleepFor(check_interval_);
    if (engine::current_task::ShouldCancel()) break;
    PerformCheck();
  }
}

yaml_config::Schema AppSecretParityChecker::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(
      kAppSecretParityCheckerComponentSchema);
}

}  // namespace six_feat