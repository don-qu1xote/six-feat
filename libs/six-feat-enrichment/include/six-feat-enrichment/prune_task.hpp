#pragma once

#include <six-feat-storage/persistent_store.hpp>

#include <chrono>
#include <cstdint>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class PruneTask final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "prune-task";

  PruneTask(const userver::components::ComponentConfig& config,
            const userver::components::ComponentContext& context);

  ~PruneTask() override;

  void OnAllComponentsLoaded() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  void Loop();
  void RunOnce();
  PersistentStore& store_;
  const std::chrono::seconds interval_;
  const int batch_size_;
  const int ttl_days_;

  userver::engine::TaskProcessor& bg_tp_;
  userver::engine::TaskWithResult<void> task_;
};

}  // namespace six_feat