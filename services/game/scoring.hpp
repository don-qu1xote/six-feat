#pragma once

// ════════════════════════════════════════════════════════════════════════════
// scoring.hpp — [SF-GAME-15] Deterministic scoring + Elo-style rating update.
//
// Pure functions, header-only, no component — same shape as
// chain_validator.hpp/game_session.hpp. Both take only already-known,
// server-computed inputs (never anything the client could shape a verdict
// with beyond the chain length it actually submitted), so the same inputs
// always produce the same outputs — required by the ticket ("скоринг ...
// детерминированы") and by tests/test_game_submit.py, which reimplements
// this exact arithmetic in Python to assert an exact match.
//
// ── Scoring ──────────────────────────────────────────────────────────────
// optimal_len/player_len are hop counts (edges: chain.size() - 1). A correct
// BFS ideal is always <= any real chain between the same two endpoints, so
// player_len < optimal_len should never happen; if it somehow did (a stale
// ideal, say), extra_hops clamps to 0 rather than granting bonus points.
//
// prior_attempts is the count of this player's EARLIER attempts (valid or
// invalid) at this SAME challenge, before the one being scored right now —
// always server-counted (GameStore::RecordValidAttempt queries
// game_attempts itself, inside the same transaction), never client-supplied.
// This is also how a fabricated ("invalid") attempt "counts against" a
// later real submission, per the ticket ("невалид снижают") — RecordInvalidAttempt
// persists a row too, so it's included in this count next time.
//
// elapsed_ms is optional and client-reported: there is no server-persisted
// "challenge started at" timestamp yet (that would need the not-yet-built
// challenge-fetch flow, SF-GAME-16, to stamp one), so an elapsed time can't
// be independently verified here. Rather than pretend to enforce something
// unverifiable, a missing elapsed_ms applies no time penalty at all; a
// present one is still only a soft, capped nudge (a handful of points, never
// enough to swing a result the way a fabricated hop would) — documented here
// as a known, deliberate limitation, not a silent gap.
//
// ── Elo ──────────────────────────────────────────────────────────────────
// Standard logistic Elo curve (base-400, the classical convention), with the
// challenge itself standing in for an "opponent" rated by its own
// difficulty (a longer optimal path is a harder challenge, so it gets a
// higher rating) and "result" being how close the attempt came to the ideal
// (score/kMaxScore, continuous in [0,1]) instead of a binary win/loss — a
// near-perfect run against an easy challenge still nets a small positive
// delta, and a mediocre run against a hard one still gains ground, matching
// the ticket's "результат = близость к идеалу".
// ════════════════════════════════════════════════════════════════════════════

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>

namespace six_feat::game {

constexpr int kMaxScore              = 1000;
constexpr int kLenPenaltyPerHop      = 100;   // per hop beyond optimal_len
constexpr int kAttemptPenaltyPerPrior = 50;   // per prior attempt on this challenge
constexpr int kTimeFreeBudgetMs      = 30000; // no time penalty under this
constexpr int kTimeBucketMs          = 2000;  // penalty granularity beyond the budget
constexpr int kTimePenaltyPerBucket  = 1;     // points per bucket over budget

inline int ComputeScore(int optimal_len, int player_len, int prior_attempts,
                        std::optional<int> elapsed_ms) {
    int score = kMaxScore;

    const int extra_hops = std::max(0, player_len - optimal_len);
    score -= extra_hops * kLenPenaltyPerHop;

    score -= std::max(0, prior_attempts) * kAttemptPenaltyPerPrior;

    if (elapsed_ms && *elapsed_ms > kTimeFreeBudgetMs) {
        const int over = *elapsed_ms - kTimeFreeBudgetMs;
        score -= (over / kTimeBucketMs) * kTimePenaltyPerBucket;
    }

    return std::clamp(score, 0, kMaxScore);
}

constexpr int    kBaseChallengeRating = 1200;  // difficulty rating of a 0-hop "challenge"
constexpr int    kRatingPerOptimalHop = 60;    // + per hop of optimal_len
constexpr double kEloDivisor          = 400.0; // classical Elo base
constexpr int    kEloK                = 24;    // classical-ish K-factor
constexpr int    kMinRating           = 100;   // floor — a rating can never bottom out at/below 0

struct EloUpdate {
    int    challenge_rating{0};
    double expected{0.0};   // player's expected "result" against this challenge, in [0,1]
    double result{0.0};     // actual "result" = score / max_score, in [0,1]
    int    delta{0};
    int    new_rating{0};
};

inline EloUpdate UpdateElo(int player_rating, int optimal_len, int score, int max_score) {
    EloUpdate u;
    u.challenge_rating = kBaseChallengeRating + optimal_len * kRatingPerOptimalHop;
    u.expected = 1.0 / (1.0 + std::pow(10.0, (u.challenge_rating - player_rating) / kEloDivisor));
    u.result   = max_score > 0 ? static_cast<double>(score) / static_cast<double>(max_score) : 0.0;

    const double raw_delta = kEloK * (u.result - u.expected);
    u.delta      = static_cast<int>(std::lround(raw_delta));
    u.new_rating = std::max(kMinRating, player_rating + u.delta);
    return u;
}

} // namespace six_feat::game
