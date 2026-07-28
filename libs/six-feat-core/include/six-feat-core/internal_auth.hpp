#pragma once

#include <string>
#include <string_view>

namespace six_feat::internal_api {

inline constexpr std::string_view kSecretHeader = "X-Internal-Secret";

std::string SharedSecretFromEnv();

bool SecretEquals(std::string_view given, std::string_view expected);

}  // namespace six_feat::internal_api