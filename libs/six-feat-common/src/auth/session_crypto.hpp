#pragma once
// ════════════════════════════════════════════════════════════════════════════
// session_crypto.hpp
//
// AES-256-GCM encrypt/decrypt для хранения Genius access_token в cookie.
// Ключ — 32 байта, берётся из APP_SECRET env var (SHA-256 от строки если
// пользователь задал произвольный пароль вместо hex-ключа).
//
// Нет userver-зависимостей — чистый C++17 + OpenSSL EVP.
// Потокобезопасен: никакого mutable состояния, только аргументы функций.
// ════════════════════════════════════════════════════════════════════════════

#include <array>
#include <cstdint>
#include <optional>
#include <string>

namespace six_feat::auth {

// Зашифровать access_token + exp в base64url-строку для cookie.
// key — ровно 32 байта (AES-256).
// Бросает std::runtime_error если OpenSSL вернул ошибку.
std::string Encrypt(std::string_view                     access_token,
                    std::int64_t                         expires_at_unix,
                    const std::array<unsigned char, 32>& key,
                    std::string_view                     name = "");

struct SessionData {
    std::string  access_token;
    std::int64_t expires_at_unix{0};
    std::string  name;  // Genius username (может быть пустым)
};

// Расшифровать cookie-значение.
// Возвращает nullopt если:
//   - base64url некорректный
//   - GCM authentication tag не совпал (подделка / повреждение)
//   - токен просрочен (exp < now)
std::optional<SessionData> Decrypt(
    std::string_view                     cookie_value,
    const std::array<unsigned char, 32>& key);

// Получить ключ из APP_SECRET:
//   - если APP_SECRET — 64 hex-символа → интерпретировать как 32 байта напрямую
//   - иначе → SHA-256(APP_SECRET) → 32 байта
// Бросает std::runtime_error если APP_SECRET не задан или пустой.
std::array<unsigned char, 32> KeyFromEnv();

// [SF-SEC-01] Non-invertible fingerprint of the session-encryption key:
// hex(SHA-256(kFingerprintSalt || key)). Safe to publish over HTTP/logs —
// the fixed salt plus one-way SHA-256 mean it cannot be reversed to recover
// APP_SECRET or `key` itself — used to detect an APP_SECRET mismatch
// between six_feat and six-feat-auth (see
// services/six-feat/src/auth/app_secret_parity_checker.hpp and
// services/auth/internal_handlers.hpp) without ever transmitting the
// secret across the internal mesh.
std::string KeyFingerprint(const std::array<unsigned char, 32>& key);

} // namespace six_feat::auth
