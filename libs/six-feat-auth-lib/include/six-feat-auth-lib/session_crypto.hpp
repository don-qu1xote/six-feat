#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>

namespace six_feat::auth {

std::string Encrypt(std::string_view access_token,
                    std::int64_t expires_at_unix,
                    const std::array<unsigned char, 32>& key,
                    std::string_view name = "");

struct SessionData {
  std::string access_token;
  std::int64_t expires_at_unix{0};
  std::string name;
};

std::optional<SessionData> Decrypt(std::string_view cookie_value,
                                   const std::array<unsigned char, 32>& key);

std::array<unsigned char, 32> KeyFromEnv();

std::string KeyFingerprint(const std::array<unsigned char, 32>& key);

}  // namespace six_feat::auth