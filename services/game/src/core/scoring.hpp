#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>

namespace six_feat::game {

constexpr int kMaxScore = 1000;
constexpr int kLenPenaltyPerHop = 100;
constexpr int kAttemptPenaltyPerPrior = 50;
constexpr int kTimeFreeBudgetMs = 30000;
constexpr int kTimeBucketMs = 2000;
constexpr int kTimePenaltyPerBucket = 1;
inline int ComputeScore(int optimal_len,
                        int player_len,
                        int prior_attempts,
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

constexpr int kBaseChallengeRating = 1200;
constexpr int kRatingPerOptimalHop = 60;
constexpr double kEloDivisor = 400.0;
constexpr int kEloK = 24;
constexpr int kMinRating = 100;
struct EloUpdate {
  int challenge_rating{0};
  double expected{0.0};
  double result{0.0};
  int delta{0};
  int new_rating{0};
};

inline EloUpdate UpdateElo(int player_rating, int optimal_len, int score, int max_score) {
  EloUpdate u;
  u.challenge_rating = kBaseChallengeRating + optimal_len * kRatingPerOptimalHop;
  u.expected = 1.0 / (1.0 + std::pow(10.0, (u.challenge_rating - player_rating) / kEloDivisor));
  u.result = max_score > 0 ? static_cast<double>(score) / static_cast<double>(max_score) : 0.0;

  const double raw_delta = kEloK * (u.result - u.expected);
  u.delta = static_cast<int>(std::lround(raw_delta));
  u.new_rating = std::max(kMinRating, player_rating + u.delta);
  return u;
}

}  // namespace six_feat::game