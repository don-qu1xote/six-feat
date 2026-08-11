#include <cstdlib>
#include <openssl/crypto.h>
#include <six-feat-core/internal_auth.hpp>
#include <stdexcept>

namespace six_feat::internal_api {

bool SecretEquals(std::string_view given, std::string_view expected) {
  if (given.empty()) return false;
  if (given.size() != expected.size()) return false;
  return CRYPTO_memcmp(given.data(), expected.data(), given.size()) == 0;
}

std::string SharedSecretFromEnv() {
  const char* value = std::getenv("ENRICHMENT_INTERNAL_SECRET");
  if (!value || !*value) {
    throw std::runtime_error(
        "ENRICHMENT_INTERNAL_SECRET env var is required — shared secret "
        "between six_feat and six-feat-enrichment, generate with: "
        "openssl rand -hex 32");
  }
  return std::string(value);
}

}  // namespace six_feat::internal_api