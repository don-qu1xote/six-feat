#pragma once

#include <chrono>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class ChallengeRules;
class GameStore;
class NeighboursClient;

class DailyChallengeTask final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "daily-challenge-task";

  DailyChallengeTask(const userver::components::ComponentConfig& config,
                     const userver::components::ComponentContext& context);

  ~DailyChallengeTask() override;

  void OnAllComponentsLoaded() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  void Loop();
  bool RunOnce();

  GameStore& store_;
  const NeighboursClient& neighbours_;
  const ChallengeRules& rules_;
  const std::chrono::seconds interval_;
  const int max_attempts_;
  const int candidate_pool_size_;

  userver::engine::TaskProcessor& main_tp_;
  userver::engine::TaskWithResult<void> task_;
};

}  // namespace six_feat::game