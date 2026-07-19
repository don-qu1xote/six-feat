#pragma once

// ════════════════════════════════════════════════════════════════════════════
// game_session.hpp — [SF-GAME-12] Identify the current player from the Genius
// OAuth session, entirely locally.
//
// Reuses the same primitives six-feat's services/six-feat/src/auth/
// token_router.hpp uses (session_crypto::Decrypt over the six_feat_session
// cookie, keyed by the shared APP_SECRET) — NO HTTP call to six-feat-auth to
// validate a session, exactly like six-feat itself. The one difference: the
// game service has no Genius OAuth app config (GENIUS_CLIENT_ID/SECRET), so it
// derives the session key straight from APP_SECRET via
// session_crypto::KeyFromEnv() instead of going through OAuthConfig.
//
// The decrypted SessionData carries only {access_token, name} — there is no
// numeric Genius id anywhere in the local session (see /auth/me, which returns
// just {authenticated, name}). game_profiles.user_id is therefore a STABLE
// 63-bit hash of the Genius username: deterministic (same user → same row) and
// available without any network round-trip. If the session payload ever starts
// carrying the real numeric Genius id, StableUserId is the single place to swap.
//
// Header-only, no component — same shape as token_router.hpp.
// ════════════════════════════════════════════════════════════════════════════

#include "auth/session_crypto.hpp"

#include <array>
#include <cstdint>
#include <optional>
#include <string>

#include <userver/server/http/http_request.hpp>

namespace six_feat::game {

struct Player {
    std::int64_t user_id;
    std::string  name;  // Genius username (may be empty → "Genius User" default)
};

// FNV-1a 64-bit over the username, masked to a positive 63-bit BIGINT. Stable
// and collision-resistant enough for a display-only player key; two distinct
// usernames colliding just means two players would share a row, astronomically
// unlikely at this scale and never a correctness/security boundary (the row is
// gated by the session, not by the id).
inline std::int64_t StableUserId(std::string_view name) {
    std::uint64_t h = 1469598103934665603ULL;  // FNV offset basis
    for (unsigned char c : name) {
        h ^= c;
        h *= 1099511628211ULL;                  // FNV prime
    }
    return static_cast<std::int64_t>(h & 0x7FFFFFFFFFFFFFFFULL);
}

// Decrypts six_feat_session locally and resolves the player. nullopt when
// there's no cookie or it's invalid/expired — the caller returns 401.
inline std::optional<Player> ResolvePlayer(
    const userver::server::http::HttpRequest& request,
    const std::array<unsigned char, 32>&      session_key)
{
    const std::string cookie = request.GetCookie("six_feat_session");
    if (cookie.empty()) return std::nullopt;

    const auto session = auth::Decrypt(cookie, session_key);
    if (!session) return std::nullopt;

    return Player{StableUserId(session->name), session->name};
}

} // namespace six_feat::game
