#include "session_crypto.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <stdexcept>
#include <vector>

namespace {

static constexpr char kB64Chars[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

std::string Base64UrlEncode(const unsigned char* data, std::size_t len) {
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  for (std::size_t i = 0; i < len; i += 3) {
    unsigned int b = static_cast<unsigned int>(data[i]) << 16;
    if (i + 1 < len) b |= static_cast<unsigned int>(data[i + 1]) << 8;
    if (i + 2 < len) b |= static_cast<unsigned int>(data[i + 2]);
    out += kB64Chars[(b >> 18) & 0x3F];
    out += kB64Chars[(b >> 12) & 0x3F];
    if (i + 1 < len) out += kB64Chars[(b >> 6) & 0x3F];
    if (i + 2 < len) out += kB64Chars[b & 0x3F];
  }
  return out;
}

static int B64CharVal(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

std::vector<unsigned char> Base64UrlDecode(std::string_view s) {
  if (s.empty()) return {};

  std::vector<unsigned char> out;
  out.reserve(s.size() * 3 / 4 + 1);

  int buf = 0, bits = 0;
  for (char c : s) {
    int val = B64CharVal(c);
    if (val < 0) return {};
    buf = (buf << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<unsigned char>((buf >> bits) & 0xFF));
    }
  }
  return out;
}

std::string JsonEscape(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

std::string JsonUnescape(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c != '\\' || i + 1 >= s.size()) {
      out += c;
      continue;
    }
    char n = s[++i];
    switch (n) {
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'u': {
        if (i + 4 < s.size()) {
          unsigned int cp = 0;
          bool ok = true;
          for (int k = 1; k <= 4 && ok; ++k) {
            char hc = s[i + k];
            cp <<= 4;
            if (hc >= '0' && hc <= '9')
              cp |= static_cast<unsigned>(hc - '0');
            else if (hc >= 'a' && hc <= 'f')
              cp |= static_cast<unsigned>(hc - 'a' + 10);
            else if (hc >= 'A' && hc <= 'F')
              cp |= static_cast<unsigned>(hc - 'A' + 10);
            else
              ok = false;
          }
          if (ok) {
            i += 4;
            if (cp < 0x80) {
              out += static_cast<char>(cp);
            } else if (cp < 0x800) {
              out += static_cast<char>(0xC0 | (cp >> 6));
              out += static_cast<char>(0x80 | (cp & 0x3F));
            } else {
              out += static_cast<char>(0xE0 | (cp >> 12));
              out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
              out += static_cast<char>(0x80 | (cp & 0x3F));
            }
          }
        }
        break;
      }
      default:
        out += n;
        break;
    }
  }
  return out;
}

std::string JsonGetString(const std::string& json, std::string_view key) {
  std::string needle = "\"";
  needle += key;
  needle += "\":\"";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return "";
  pos += needle.size();
  std::size_t i = pos;
  while (i < json.size() && json[i] != '"') {
    i += (json[i] == '\\' && i + 1 < json.size()) ? 2 : 1;
  }
  if (i >= json.size()) return "";
  return JsonUnescape(std::string_view(json).substr(pos, i - pos));
}

std::int64_t JsonGetInt(const std::string& json, std::string_view key) {
  std::string needle = "\"";
  needle += key;
  needle += "\":";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return 0;
  pos += needle.size();
  while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
  if (pos >= json.size()) return 0;
  try {
    std::size_t sz = 0;
    auto v = std::stoll(json.substr(pos), &sz);
    return v;
  } catch (...) {
    return 0;
  }
}

struct CtxGuard {
  EVP_CIPHER_CTX* p;
  explicit CtxGuard(EVP_CIPHER_CTX* ctx) : p(ctx) {}
  ~CtxGuard() {
    if (p) EVP_CIPHER_CTX_free(p);
  }
  CtxGuard(const CtxGuard&) = delete;
  CtxGuard& operator=(const CtxGuard&) = delete;
};

}  // namespace
namespace six_feat::auth {

std::string Encrypt(std::string_view access_token,
                    std::int64_t expires_at_unix,
                    const std::array<unsigned char, 32>& key,
                    std::string_view name) {
  std::string plain = "{\"tok\":\"";
  plain += JsonEscape(access_token);
  plain += "\",\"exp\":";
  plain += std::to_string(expires_at_unix);
  if (!name.empty()) {
    plain += ",\"name\":\"";
    plain += JsonEscape(name);
    plain += "\"";
  }
  plain += "}";

  std::array<unsigned char, 12> nonce{};
  if (RAND_bytes(nonce.data(), 12) != 1) throw std::runtime_error("RAND_bytes failed");

  EVP_CIPHER_CTX* raw_ctx = EVP_CIPHER_CTX_new();
  if (!raw_ctx) throw std::runtime_error("EVP_CIPHER_CTX_new failed");
  CtxGuard guard(raw_ctx);

  std::vector<unsigned char> ciphertext(plain.size());
  std::array<unsigned char, 16> tag{};
  int len = 0, clen = 0;

  if (EVP_EncryptInit_ex(raw_ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1)
    throw std::runtime_error("EVP_EncryptInit_ex (cipher) failed");
  if (EVP_CIPHER_CTX_ctrl(raw_ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr) != 1)
    throw std::runtime_error("EVP_CIPHER_CTX_ctrl (ivlen) failed");
  if (EVP_EncryptInit_ex(raw_ctx, nullptr, nullptr, key.data(), nonce.data()) != 1)
    throw std::runtime_error("EVP_EncryptInit_ex (key/iv) failed");
  if (EVP_EncryptUpdate(raw_ctx,
                        ciphertext.data(),
                        &len,
                        reinterpret_cast<const unsigned char*>(plain.data()),
                        static_cast<int>(plain.size())) != 1)
    throw std::runtime_error("EVP_EncryptUpdate failed");
  clen = len;
  if (EVP_EncryptFinal_ex(raw_ctx, ciphertext.data() + clen, &len) != 1)
    throw std::runtime_error("EVP_EncryptFinal_ex failed");
  clen += len;
  if (EVP_CIPHER_CTX_ctrl(raw_ctx, EVP_CTRL_GCM_GET_TAG, 16, tag.data()) != 1)
    throw std::runtime_error("EVP_CIPHER_CTX_ctrl (get tag) failed");
  ciphertext.resize(clen);

  std::vector<unsigned char> payload;
  payload.reserve(12 + clen + 16);
  payload.insert(payload.end(), nonce.begin(), nonce.end());
  payload.insert(payload.end(), ciphertext.begin(), ciphertext.end());
  payload.insert(payload.end(), tag.begin(), tag.end());

  return Base64UrlEncode(payload.data(), payload.size());
}

std::optional<SessionData> Decrypt(std::string_view cookie_value,
                                   const std::array<unsigned char, 32>& key) {
  auto payload = Base64UrlDecode(cookie_value);
  if (payload.size() < 29) return std::nullopt;

  const unsigned char* nonce = payload.data();
  const unsigned char* ciphertext = payload.data() + 12;
  const std::size_t clen = payload.size() - 12 - 16;
  const unsigned char* tag_ptr = payload.data() + 12 + clen;

  std::vector<unsigned char> plain(clen);
  int len = 0, plen = 0;

  EVP_CIPHER_CTX* raw_ctx = EVP_CIPHER_CTX_new();
  if (!raw_ctx) return std::nullopt;
  CtxGuard guard(raw_ctx);

  if (EVP_DecryptInit_ex(raw_ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1)
    return std::nullopt;
  if (EVP_CIPHER_CTX_ctrl(raw_ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr) != 1) return std::nullopt;
  if (EVP_DecryptInit_ex(raw_ctx, nullptr, nullptr, key.data(), nonce) != 1) return std::nullopt;
  if (EVP_DecryptUpdate(raw_ctx, plain.data(), &len, ciphertext, static_cast<int>(clen)) != 1)
    return std::nullopt;
  plen = len;
  if (EVP_CIPHER_CTX_ctrl(raw_ctx, EVP_CTRL_GCM_SET_TAG, 16, const_cast<unsigned char*>(tag_ptr)) !=
      1)
    return std::nullopt;
  const int ok = EVP_DecryptFinal_ex(raw_ctx, plain.data() + plen, &len);

  if (ok <= 0) return std::nullopt;
  plen += len;

  const std::string json(reinterpret_cast<char*>(plain.data()), plen);

  SessionData data;
  data.access_token = JsonGetString(json, "tok");
  data.expires_at_unix = JsonGetInt(json, "exp");
  data.name = JsonGetString(json, "name");

  if (data.access_token.empty()) return std::nullopt;

  using SC = std::chrono::system_clock;
  const auto now_unix = static_cast<std::int64_t>(
      std::chrono::duration_cast<std::chrono::seconds>(SC::now().time_since_epoch()).count());
  if (data.expires_at_unix < now_unix) return std::nullopt;

  return data;
}

std::string KeyFingerprint(const std::array<unsigned char, 32>& key) {
  static constexpr std::string_view kFingerprintSalt = "six-feat-app-secret-fingerprint-v1";

  std::vector<unsigned char> salted;
  salted.reserve(kFingerprintSalt.size() + key.size());
  salted.insert(salted.end(), kFingerprintSalt.begin(), kFingerprintSalt.end());
  salted.insert(salted.end(), key.begin(), key.end());

  std::array<unsigned char, 32> digest{};
  SHA256(salted.data(), salted.size(), digest.data());

  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (unsigned char b : digest) {
    out += kHex[(b >> 4) & 0xF];
    out += kHex[b & 0xF];
  }
  return out;
}

std::array<unsigned char, 32> KeyFromEnv() {
  const char* secret = std::getenv("APP_SECRET");
  if (!secret || !*secret)
    throw std::runtime_error(
        "APP_SECRET env var is required for session encryption. "
        "Generate with: openssl rand -hex 32");

  const std::string s(secret);

  if (s.size() == 64 && s.find_first_not_of("0123456789abcdefABCDEF") == std::string::npos) {
    std::array<unsigned char, 32> key{};
    for (int i = 0; i < 32; ++i) {
      key[i] = static_cast<unsigned char>(
          std::stoul(s.substr(static_cast<std::string::size_type>(i) * 2, 2), nullptr, 16));
    }
    return key;
  }

  std::array<unsigned char, 32> key{};
  SHA256(reinterpret_cast<const unsigned char*>(s.data()), s.size(), key.data());
  return key;
}

}  // namespace six_feat::auth