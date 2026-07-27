#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>
#include <utility>
#include <vector>

namespace six_feat::game {

struct Profile {
  std::int64_t user_id{0};
  std::string display_name;
  std::string avatar_url;
  int elo{0};
  int games{0};
  int rank{0};
};

struct Season {
  std::int64_t id{0};
  std::string name;
  std::int64_t starts_ts{0};
  std::int64_t ends_ts{0};
};

struct Challenge {
  std::int64_t id{0};
  std::int64_t from_artist_id{0};
  std::int64_t to_artist_id{0};
  int role_mask{0};
  std::string kind;
  std::optional<int> optimal_len;
  std::vector<std::int64_t> optimal_path;
  std::optional<std::int64_t> season_id;
};

struct SubmitResult {
  int player_len{0};
  int score{0};
  int max_score{0};
  int elo_before{0};
  int elo_after{0};
  int elo_delta{0};
  int games_after{0};
};

struct ChallengeUpsertResult {
  std::int64_t id{0};
  bool created{false};
  std::optional<int> optimal_len;
  std::vector<std::int64_t> optimal_path;
  std::optional<std::int64_t> season_id;
};

struct ArtistRef {
  std::int64_t id{0};
  std::string name;
  std::optional<std::string> image_url;
};

struct DailyChallengeView {
  Challenge challenge;
  ArtistRef from;
  ArtistRef to;
};

struct ChallengeListItem {
  Challenge challenge;
  ArtistRef from;
  ArtistRef to;
  std::int64_t created_ts{0};
};

struct LeaderboardEntry {
  std::int64_t user_id{0};
  std::string display_name;
  int score{0};
  int hops{0};
  std::int64_t ts{0};
  int elo{0};
  int games{0};
};

struct LeaderboardPage {
  std::vector<LeaderboardEntry> entries;
  std::optional<std::string> next_cursor;
};

enum class LeaderboardScope { kChallenge, kSeason };

struct AttemptSummary {
  std::int64_t challenge_id{0};
  bool valid{false};
  int score{0};
  int hops{0};
  std::int64_t ts{0};
};

struct Achievement {
  std::string code;
  std::string title;
  std::string descr;
  std::int64_t ts{0};
};

class GameStore final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "game-store";

  GameStore(const userver::components::ComponentConfig& config,
            const userver::components::ComponentContext& context);

  ~GameStore() override;

  void OnAllComponentsLoaded() override;

  bool Ping() const;

  Profile EnsureAndGetProfile(std::int64_t user_id,
                              const std::string& display_name_default,
                              const std::string& avatar_url_default) const;

  Profile SetDisplayName(std::int64_t user_id, const std::string& display_name) const;

  std::optional<Profile> GetProfileIfExists(std::int64_t user_id) const;

  std::vector<AttemptSummary> ListRecentAttempts(std::int64_t user_id, int limit) const;

  std::optional<Challenge> GetChallenge(std::int64_t challenge_id) const;

  void RecordInvalidAttempt(std::int64_t user_id,
                            std::int64_t challenge_id,
                            const std::vector<std::int64_t>& chain) const;

  SubmitResult RecordValidAttempt(std::int64_t user_id,
                                  std::int64_t challenge_id,
                                  const std::vector<std::int64_t>& chain,
                                  int optimal_len,
                                  std::optional<int> elapsed_ms,
                                  std::optional<std::int64_t> season_id) const;

  std::vector<std::string> EvaluateAndAwardAchievements(std::int64_t user_id,
                                                        const SubmitResult& outcome,
                                                        std::optional<int> elapsed_ms) const;

  std::vector<Achievement> ListAchievementCatalog() const;

  std::vector<Achievement> ListAchievements(std::int64_t user_id) const;

  Season EnsureCurrentSeason() const;

  ChallengeUpsertResult UpsertChallenge(std::int64_t from_artist_id,
                                        std::int64_t to_artist_id,
                                        int role_mask,
                                        const std::string& kind,
                                        std::optional<std::int64_t> created_by,
                                        std::optional<std::int64_t> season_id) const;

  bool SetChallengeIdeal(std::int64_t challenge_id,
                         int optimal_len,
                         const std::vector<std::int64_t>& optimal_path) const;

  std::vector<std::int64_t> RandomArtistIdsWithCredits(int limit) const;

  std::optional<DailyChallengeView> GetLatestDailyChallenge() const;

  std::vector<ChallengeListItem> ListChallenges(
      const std::string& kind,
      const std::string& query,
      std::optional<std::pair<std::int64_t, std::int64_t>> cursor,
      int limit) const;

  LeaderboardPage GetLeaderboard(LeaderboardScope scope,
                                 std::int64_t scope_id,
                                 const std::optional<std::string>& cursor,
                                 int limit) const;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  struct Impl;
  userver::engine::TaskProcessor& main_tp_;
  std::unique_ptr<Impl> impl_;
  userver::engine::TaskWithResult<void> migration_task_;
};

}  // namespace six_feat::game