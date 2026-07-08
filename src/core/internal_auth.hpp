#pragma once

// Shared-secret auth for the internal API between six_feat and
// six-feat-enrichment (POST /internal/enqueue, GET /internal/status).
// Both sides read the same secret from ENRICHMENT_INTERNAL_SECRET — never
// written to a config file, same handling as APP_SECRET / GENIUS_CLIENT_SECRET.
//
// No userver dependencies — linkable into either service's binary.

#include <string>
#include <string_view>

namespace six_feat::internal_api {

inline constexpr std::string_view kSecretHeader = "X-Internal-Secret";

// Reads ENRICHMENT_INTERNAL_SECRET from the process environment.
// Throws std::runtime_error if unset/empty.
std::string SharedSecretFromEnv();

// Constant-time comparison of the given secret against the expected one.
// Empty `given` always returns false.
bool SecretEquals(std::string_view given, std::string_view expected);

} // namespace six_feat::internal_api