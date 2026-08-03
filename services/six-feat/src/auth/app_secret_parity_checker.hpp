#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
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

  enum class Status : std::uint8_t {
    kUnknown,
    kOk,
    kMismatch,
    kUnreachable,
  };

  static std::string_view ToString(Status status);

  AppSecretParityChecker(const userver::components::ComponentConfig& config,
                         const userver::components::ComponentContext& context);

  ~AppSecretParityChecker() override;

  void OnAllComponentsLoaded() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

  Status GetStatus() const;

 private:
  void PerformCheck();
  void CheckLoop();

  userver::clients::http::Client& http_client_;
  const std::string auth_base_url_;
  const std::string shared_secret_;
  const std::chrono::milliseconds timeout_;
  const std::chrono::milliseconds check_interval_;
  const std::string own_fingerprint_;

  userver::engine::TaskProcessor& fs_tp_;

  std::atomic<Status> status_{Status::kUnknown};
  userver::engine::TaskWithResult<void> check_task_;
};

}  // namespace six_feat