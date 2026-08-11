#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace six_feat::auth {

inline constexpr std::string_view kProviderGenius = "genius";

std::string Encrypt(std::string_view access_token,
                    std::int64_t expires_at_unix,
                    const std::array<unsigned char, 32>& key,
                    std::string_view name = "",
                    std::string_view provider = "",
                    std::string_view provider_user_id = "");

struct SessionData {
  std::string access_token;
  std::int64_t expires_at_unix{0};
  std::string name;
  std::string provider;
  std::string provider_user_id;

  std::string_view Provider() const {
    return provider.empty() ? kProviderGenius : std::string_view{provider};
  }
};

std::optional<SessionData> Decrypt(std::string_view cookie_value,
                                   const std::array<unsigned char, 32>& key);

std::array<unsigned char, 32> KeyFromEnv();

std::string KeyFingerprint(const std::array<unsigned char, 32>& key);

std::string HashApiKey(std::string_view raw_key);

}  // namespace six_feat::auth