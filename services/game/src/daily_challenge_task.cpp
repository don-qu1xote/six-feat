#include "daily_challenge_task.hpp"

#include "schemas/components/daily_challenge_task_schema.hpp"

#include <stdexcept>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/cancel.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/utils/rand.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "game_store.hpp"
#include "ideal_finder.hpp"
#include "neighbours_client.hpp"

namespace six_feat::game {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("daily-challenge-task: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

constexpr int kAllRolesMask = 15;

}  // namespace
DailyChallengeTask::DailyChallengeTask(const components::ComponentConfig& config,
                                       const components::ComponentContext& context)
    : ComponentBase(config, context),
      store_(context.FindComponent<GameStore>()),
      neighbours_(context.FindComponent<NeighboursClient>()),
      interval_(RequirePositive("interval-seconds", config["interval-seconds"].As<int>(86400))),
      min_path_len_(RequirePositive("min-path-len", config["min-path-len"].As<int>(2))),
      max_attempts_(RequirePositive("max-attempts", config["max-attempts"].As<int>(20))),
      candidate_pool_size_(
          RequirePositive("candidate-pool-size", config["candidate-pool-size"].As<int>(50))),
      main_tp_(context.GetTaskProcessor("main-task-processor")) {}

DailyChallengeTask::~DailyChallengeTask() {
  if (task_.IsValid()) {
    task_.RequestCancel();
    task_.Wait();
  }
}

void DailyChallengeTask::OnAllComponentsLoaded() {
  task_ = utils::Async(main_tp_, "daily-challenge-task", [this] { Loop(); });
}

void DailyChallengeTask::Loop() {
  if (!engine::current_task::ShouldCancel() && !RunOnce()) {
    LOG_WARNING() << "[DailyChallengeTask] no interesting pair found on "
                     "the startup pass — will retry next interval";
  }
  while (!engine::current_task::ShouldCancel()) {
    engine::InterruptibleSleepFor(interval_);
    if (engine::current_task::ShouldCancel()) break;
    if (!RunOnce()) {
      LOG_WARNING() << "[DailyChallengeTask] no interesting pair found "
                       "this pass — will retry next interval";
    }
  }
}

bool DailyChallengeTask::RunOnce() {
  const auto candidates = store_.RandomArtistIdsWithCredits(candidate_pool_size_);
  if (candidates.size() < 2) {
    LOG_INFO() << "[DailyChallengeTask] fewer than 2 candidate artists "
                  "with L1 data yet — nothing to publish";
    return false;
  }

  for (int attempt = 0; attempt < max_attempts_; ++attempt) {
    if (engine::current_task::ShouldCancel()) return false;

    const auto i = utils::RandRange(candidates.size());
    auto j = utils::RandRange(candidates.size());
    if (j == i) j = (j + 1) % candidates.size();
    const auto from = candidates[i];
    const auto to = candidates[j];

    const auto path = FindIdealPath(neighbours_, from, to, kAllRolesMask);
    if (!path) continue;

    const int path_len = static_cast<int>(path->size()) - 1;
    if (path_len < min_path_len_) continue;

    const auto season = store_.EnsureCurrentSeason();
    auto challenge =
        store_.UpsertChallenge(from, to, kAllRolesMask, "daily", std::nullopt, season.id);
    if (!challenge.optimal_len) {
      store_.SetChallengeIdeal(challenge.id, path_len, *path);
    }
    LOG_INFO() << "[DailyChallengeTask] published daily challenge id=" << challenge.id
               << " from=" << from << " to=" << to << " optimal_len=" << path_len;
    return true;
  }

  LOG_INFO() << "[DailyChallengeTask] exhausted " << max_attempts_
             << " candidate pairs without finding one >= " << min_path_len_ << " hops";
  return false;
}

yaml_config::Schema DailyChallengeTask::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kDailyChallengeTaskComponentSchema);
}

}  // namespace six_feat::game