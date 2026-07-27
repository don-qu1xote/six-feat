
#include "enrichment/prune_task.hpp"

#include "schemas/components/prune_task_schema.hpp"

#include <cstdlib>
#include <exception>
#include <stdexcept>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/cancel.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("prune-task: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

int PruneTtlDaysFromEnv() {
  const char* raw = std::getenv("PRUNE_TTL_DAYS");
  if (raw == nullptr || *raw == '\0') return 0;
  try {
    const int days = std::stoi(raw);
    return days > 0 ? days : 0;
  } catch (const std::exception&) {
    LOG_WARNING() << "[PruneTask] PRUNE_TTL_DAYS=\"" << raw
                  << "\" is not a valid positive integer — treating as 0 (disabled)";
    return 0;
  }
}

}  // namespace
PruneTask::PruneTask(const components::ComponentConfig& config,
                     const components::ComponentContext& context)
    : ComponentBase(config, context),
      store_(context.FindComponent<PersistentStore>()),
      interval_(RequirePositive("interval-seconds", config["interval-seconds"].As<int>(3600))),
      batch_size_(RequirePositive("batch-size", config["batch-size"].As<int>(500))),
      ttl_days_(PruneTtlDaysFromEnv()),
      bg_tp_(context.GetTaskProcessor("bg-enrichment")) {}

PruneTask::~PruneTask() {
  if (task_.IsValid()) {
    task_.RequestCancel();
    task_.Wait();
  }
}

void PruneTask::OnAllComponentsLoaded() {
  if (ttl_days_ <= 0) {
    LOG_INFO() << "[PruneTask] disabled (PRUNE_TTL_DAYS=0) — no "
                  "background task started, current behavior unchanged";
    return;
  }

  LOG_INFO() << "[PruneTask] enabled: ttl_days=" << ttl_days_ << " interval=" << interval_.count()
             << "s batch_size=" << batch_size_;
  task_ = utils::Async(bg_tp_, "prune-task", [this] { Loop(); });
}

void PruneTask::Loop() {
  while (!engine::current_task::ShouldCancel()) {
    engine::InterruptibleSleepFor(interval_);
    if (engine::current_task::ShouldCancel()) break;
    RunOnce();
  }
}

void PruneTask::RunOnce() {
  const auto now_s = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
  const auto cutoff_ts =
      static_cast<std::int64_t>(now_s) - static_cast<std::int64_t>(ttl_days_) * 24 * 3600;

  std::int64_t total_pruned = 0;
  for (;;) {
    if (engine::current_task::ShouldCancel()) break;
    const auto pruned = store_.PruneStaleArtists(cutoff_ts, batch_size_);
    if (pruned == 0) break;
    total_pruned += pruned;
  }

  if (total_pruned > 0) {
    LOG_INFO() << "[PruneTask] pruned " << total_pruned
               << " stale artist(s) this pass (cutoff_ts=" << cutoff_ts
               << ", ttl_days=" << ttl_days_ << ")";
  } else {
    LOG_DEBUG() << "[PruneTask] nothing to prune this pass";
  }
}

yaml_config::Schema PruneTask::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kPruneTaskComponentSchema);
}

}  // namespace six_feat