#include <array>
#include <memory>
#include <openssl/evp.h>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/idempotency.hpp>
#include <span>
#include <stdexcept>

namespace six_feat {

namespace {

struct EvpMdCtxDeleter {
  void operator()(EVP_MD_CTX* ctx) const noexcept {
    EVP_MD_CTX_free(ctx);
  }
};
using EvpMdCtx = std::unique_ptr<EVP_MD_CTX, EvpMdCtxDeleter>;

std::string HashRequest(std::string_view route_id, std::string_view raw_body) {
  static constexpr unsigned char kSep = '\n';
  std::array<unsigned char, EVP_MAX_MD_SIZE> digest_buf{};
  unsigned int digest_len = 0;

  EvpMdCtx ctx{EVP_MD_CTX_new()};
  if (!ctx || EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) != 1 ||
      EVP_DigestUpdate(ctx.get(), route_id.data(), route_id.size()) != 1 ||
      EVP_DigestUpdate(ctx.get(), &kSep, 1) != 1 ||
      EVP_DigestUpdate(ctx.get(), raw_body.data(), raw_body.size()) != 1 ||
      EVP_DigestFinal_ex(ctx.get(), digest_buf.data(), &digest_len) != 1) {
    throw std::runtime_error("idempotency: SHA-256 failed");
  }
  const std::span<const unsigned char> digest{digest_buf.data(), digest_len};

  static constexpr const char* kHex = "0123456789abcdef";
  std::string out;
  out.reserve(digest.size() * 2);
  for (unsigned char b : digest) {
    out += kHex[(b >> 4) & 0xF];
    out += kHex[b & 0xF];
  }
  return out;
}

}  // namespace

IdempotentResult RunIdempotent(const userver::server::http::HttpRequest& request,
                               const IdempotencyStore& store,
                               std::string_view route_id,
                               std::chrono::seconds ttl,
                               const std::function<IdempotentResult()>& body) {
  const std::string& key = request.GetHeader(kIdempotencyKeyHeader);
  if (key.empty()) {
    return body();
  }

  const std::string request_hash = HashRequest(route_id, request.RequestBody());

  const auto lookup = store.Lookup(key, request_hash);
  if (lookup.key_reused_with_different_request) {
    return IdempotentResult{
        userver::server::http::HttpStatus::kUnprocessableEntity,
        BuildProblemJson(request,
                         userver::server::http::HttpStatus::kUnprocessableEntity,
                         "Idempotency-Key already used with a different request")};
  }
  if (lookup.cached) {
    request.GetHttpResponse().SetHeader(std::string{"Idempotent-Replay"}, std::string{"true"});
    return IdempotentResult{
        static_cast<userver::server::http::HttpStatus>(lookup.cached->status_code),
        lookup.cached->body};
  }

  IdempotentResult result = body();
  store.Store(key, request_hash, static_cast<int>(result.status), result.body, ttl);
  return result;
}

}  // namespace six_feat
