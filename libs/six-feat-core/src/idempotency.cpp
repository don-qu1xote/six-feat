#include <array>
#include <openssl/sha.h>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/idempotency.hpp>

namespace six_feat {

namespace {

std::string HashRequest(std::string_view route_id, std::string_view raw_body) {
  SHA256_CTX ctx;
  SHA256_Init(&ctx);
  SHA256_Update(&ctx, route_id.data(), route_id.size());
  static constexpr unsigned char kSep = '\n';
  SHA256_Update(&ctx, &kSep, 1);
  SHA256_Update(&ctx, raw_body.data(), raw_body.size());

  std::array<unsigned char, SHA256_DIGEST_LENGTH> digest{};
  SHA256_Final(digest.data(), &ctx);

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
