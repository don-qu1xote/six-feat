#pragma once

#include <chrono>
#include <six-feat-core/resilience.hpp>
#include <string>
#include <string_view>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/utils/statistics/entry.hpp>
#include <userver/utils/statistics/fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

struct YandexDeviceCode {
  std::string device_code;
  std::string user_code;
  std::string verification_url;
  int interval_seconds{5};
  int expires_in_seconds{600};
};

enum class YandexTokenPollStatus { kSuccess, kPending, kDenied, kExpired };

struct YandexTokenPollResult {
  YandexTokenPollStatus status{YandexTokenPollStatus::kPending};
  std::string access_token;
  std::string refresh_token;
  int expires_in_seconds{0};
};

class YandexDeviceAuthClient final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "yandex-device-auth-client";

  YandexDeviceAuthClient(const userver::components::ComponentConfig& config,
                         const userver::components::ComponentContext& context);

  ~YandexDeviceAuthClient() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

  YandexDeviceCode RequestDeviceCode() const;

  YandexTokenPollResult PollForToken(const std::string& device_code) const;

  CircuitBreaker::State CbState() const {
    return pipeline_.CbState();
  }

 private:
  std::string PostForm(const std::string& url, const std::string& body) const;

  void ExtendStatistics(userver::utils::statistics::Writer& writer) const;

  userver::clients::http::Client& http_client_;
  const std::string device_code_url_;
  const std::string token_url_;
  const std::string client_id_;
  const int backoff_max_attempts_;
  const std::chrono::milliseconds backoff_base_ms_;
  const std::chrono::milliseconds backoff_cap_ms_;

  mutable ResiliencePipeline pipeline_;

  userver::utils::statistics::Entry statistics_holder_;
};

}  // namespace six_feat
