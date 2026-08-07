
#include "schemas/components/yandex_device_auth_client_schema.hpp"

#include <cctype>
#include <chrono>
#include <cstdlib>
#include <six-feat-core/request_id.hpp>
#include <six-feat-yandex/yandex_device_auth_client.hpp>
#include <stdexcept>
#include <string>
#include <userver/clients/http/client.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/components/statistics_storage.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/cancel.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/statistics/writer.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("yandex-device-auth-client: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

double RequirePositive(std::string_view param, double value) {
  if (!(value > 0.0)) {
    throw std::runtime_error("yandex-device-auth-client: " + std::string(param) +
                             " must be a positive number, got " + std::to_string(value));
  }
  return value;
}

std::string EnvOrEmpty(const char* name) {
  const char* value = std::getenv(name);
  return value ? std::string(value) : std::string();
}

std::string UrlEncode(std::string_view value) {
  static constexpr const char* kHex = "0123456789ABCDEF";
  std::string out;
  out.reserve(value.size() * 3);
  for (unsigned char c : value) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~')
      out.push_back(static_cast<char>(c));
    else {
      out.push_back('%');
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0x0F]);
    }
  }
  return out;
}

}  // namespace

YandexDeviceAuthClient::YandexDeviceAuthClient(const components::ComponentConfig& config,
                                               const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      device_code_url_(
          config["device-code-url"].As<std::string>("https://oauth.yandex.ru/device/code")),
      token_url_(config["token-url"].As<std::string>("https://oauth.yandex.ru/token")),
      client_id_(config["client-id"].As<std::string>("")),
      client_secret_(EnvOrEmpty("YANDEX_DEVICE_CLIENT_SECRET")),
      scope_(config["scope"].As<std::string>("")),
      backoff_max_attempts_(
          RequirePositive("backoff-max-attempts", config["backoff-max-attempts"].As<int>(4))),
      backoff_base_ms_(std::chrono::milliseconds{
          RequirePositive("backoff-base-ms", config["backoff-base-ms"].As<int>(200))}),
      backoff_cap_ms_(std::chrono::milliseconds{
          RequirePositive("backoff-cap-ms", config["backoff-cap-ms"].As<int>(10000))}),
      pipeline_(LaneConfig{RequirePositive("lane-fg-tokens-per-sec",
                                           config["lane-fg-tokens-per-sec"].As<double>(2.0)),
                           RequirePositive("lane-fg-burst", config["lane-fg-burst"].As<int>(2)),
                           RequirePositive("lane-fg-max-concurrent",
                                           config["lane-fg-max-concurrent"].As<int>(2))},
                LaneConfig{RequirePositive("lane-bg-tokens-per-sec",
                                           config["lane-bg-tokens-per-sec"].As<double>(1.0)),
                           RequirePositive("lane-bg-burst", config["lane-bg-burst"].As<int>(1)),
                           RequirePositive("lane-bg-max-concurrent",
                                           config["lane-bg-max-concurrent"].As<int>(1))},
                RequirePositive("cb-failure-threshold", config["cb-failure-threshold"].As<int>(5)),
                std::chrono::seconds{
                    RequirePositive("cb-open-seconds", config["cb-open-seconds"].As<int>(30))}) {
  auto& storage = context.FindComponent<components::StatisticsStorage>().GetStorage();
  statistics_holder_ = storage.RegisterWriter(
      "yandex-device-auth-client",
      [this](utils::statistics::Writer& writer) { ExtendStatistics(writer); });
}

YandexDeviceAuthClient::~YandexDeviceAuthClient() {
  statistics_holder_.Unregister();
}

void YandexDeviceAuthClient::ExtendStatistics(utils::statistics::Writer& writer) const {
  const auto state = pipeline_.CbState();
  writer["circuit_breaker"]["state"] = static_cast<int>(state);
  writer["circuit_breaker"]["closed"] = state == CircuitBreaker::State::kClosed ? 1 : 0;
  writer["circuit_breaker"]["open"] = state == CircuitBreaker::State::kOpen ? 1 : 0;
  writer["circuit_breaker"]["half_open"] = state == CircuitBreaker::State::kHalfOpen ? 1 : 0;
}

std::string YandexDeviceAuthClient::PostForm(const std::string& url,
                                             const std::string& body) const {
  const std::string& request_id = CurrentRequestId();
  int attempt = 0;
  int last_5xx_status = 502;

  while (true) {
    auto guard = pipeline_.Acquire(Lane::kForeground);
    bool failure_already_recorded = false;

    try {
      const auto resp = http_client_.CreateRequest()
                            .post(url)
                            .data(body)
                            .headers({{"Content-Type", "application/x-www-form-urlencoded"},
                                      {"X-Request-Id", request_id}})
                            .timeout(std::chrono::seconds{5})
                            .retry(0)
                            .perform();
      const int status = resp->status_code();
      pipeline_.OnResponse(guard, status, -1, 0);

      if ((status >= 200 && status < 300) || (status >= 400 && status < 500)) {
        return resp->body();
      }

      last_5xx_status = status;
      failure_already_recorded = true;
      LOG_WARNING() << "[YDeviceAuth] request_id=" << request_id << " HTTP " << status
                    << " attempt=" << attempt << " url=" << url;

    } catch (const GeniusHttpError&) {
      throw;
    } catch (const std::exception& ex) {
      if (engine::current_task::ShouldCancel()) {
        throw GeniusHttpError{499, "client request cancelled"};
      }
      pipeline_.OnNetworkError();
      failure_already_recorded = true;
      LOG_WARNING() << "[YDeviceAuth] request_id=" << request_id
                    << " network error attempt=" << attempt << ": " << ex.what();
    }

    ++attempt;
    if (attempt >= backoff_max_attempts_) {
      if (!failure_already_recorded) pipeline_.OnNetworkError();
      throw GeniusHttpError{last_5xx_status, "exhausted retries: " + url};
    }
    const auto backoff = ExponentialBackoff(attempt, backoff_base_ms_, backoff_cap_ms_);
    engine::InterruptibleSleepFor(backoff);
  }
}

YandexDeviceCode YandexDeviceAuthClient::RequestDeviceCode() const {
  std::string body = "client_id=" + UrlEncode(client_id_);
  if (!scope_.empty()) body += "&scope=" + UrlEncode(scope_);
  const auto json = formats::json::FromString(PostForm(device_code_url_, body));

  YandexDeviceCode out;
  out.device_code = json["device_code"].As<std::string>("");
  out.user_code = json["user_code"].As<std::string>("");
  out.verification_url = json["verification_url"].As<std::string>("");
  out.interval_seconds = json["interval"].As<int>(5);
  out.expires_in_seconds = json["expires_in"].As<int>(600);

  if (out.device_code.empty()) {
    throw GeniusHttpError{502, "yandex-device-auth-client: malformed device-code response"};
  }
  return out;
}

YandexTokenPollResult YandexDeviceAuthClient::PollForToken(const std::string& device_code) const {
  // [SF-WEB-91] Проверено вживую: /token требует client_secret (в отличие от /device/code).
  const std::string body = "grant_type=device_code&code=" + UrlEncode(device_code) +
                           "&client_id=" + UrlEncode(client_id_) +
                           "&client_secret=" + UrlEncode(client_secret_);
  const auto json = formats::json::FromString(PostForm(token_url_, body));

  YandexTokenPollResult out;
  const auto access_token = json["access_token"].As<std::string>("");
  if (!access_token.empty()) {
    out.status = YandexTokenPollStatus::kSuccess;
    out.access_token = access_token;
    out.refresh_token = json["refresh_token"].As<std::string>("");
    out.expires_in_seconds = json["expires_in"].As<int>(0);
    return out;
  }

  const auto error = json["error"].As<std::string>("");
  if (error == "authorization_pending" || error == "slow_down") {
    out.status = YandexTokenPollStatus::kPending;
  } else if (error == "access_denied") {
    out.status = YandexTokenPollStatus::kDenied;
  } else if (error == "expired_token" || error == "bad_verification_code") {
    out.status = YandexTokenPollStatus::kExpired;
  } else {
    throw GeniusHttpError{502, "yandex-device-auth-client: unexpected token response: " + error};
  }
  return out;
}

yaml_config::Schema YandexDeviceAuthClient::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(
      kYandexDeviceAuthClientComponentSchema);
}

}  // namespace six_feat
