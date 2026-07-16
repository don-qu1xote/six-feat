#pragma once

// ════════════════════════════════════════════════════════════════════════════
// prune_task.hpp — SF-DB-06
//
// PruneTask is an opt-in, off-by-default background component that
// periodically deletes stale artists/songs/credits from PersistentStore —
// rows whose fetch_state.last_fetch_ts is older than PRUNE_TTL_DAYS days.
// Ahead of a real "game" mode landing (see the broader S11 sprint this
// ticket sits in), unbounded growth of scanned-but-never-revisited artist
// graphs becomes a real storage concern; this closes that gap without
// changing default behavior for any existing deployment.
//
// PRUNE_TTL_DAYS (env var, default "0" = off) is the single on/off switch —
// deliberately not a YAML config key, same posture as security_headers.cpp's
// COOKIE_SECURE: an operational toggle read once at startup, not a per-
// environment schema field. interval-seconds/batch-size (YAML, this
// component's own static_config.yaml block) tune an already-enabled task,
// they don't turn it on.
//
// Same "hand-rolled coroutine + InterruptibleSleepFor + RequestCancel on
// shutdown" shape as AppSecretParityChecker
// (services/six-feat/src/auth/app_secret_parity_checker.hpp) — this repo has
// no userver::utils::PeriodicTask usage anywhere, that shape is the
// established idiom for "run X periodically" here.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/persistent_store.hpp"

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

    PruneTask(const userver::components::ComponentConfig&  config,
              const userver::components::ComponentContext& context);

    ~PruneTask() override;

    // Starts the background loop — only if PRUNE_TTL_DAYS > 0. A disabled
    // PruneTask never spawns a coroutine at all, so it's a true no-op:
    // zero behavior change for any deployment that doesn't set the env var.
    void OnAllComponentsLoaded() override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    void Loop();      // runs on bg-enrichment TP
    void RunOnce();   // drains every currently-stale batch, logs the total

    PersistentStore& store_;
    const std::chrono::seconds interval_;
    const int                  batch_size_;
    const int                  ttl_days_;

    userver::engine::TaskProcessor& bg_tp_;
    userver::engine::TaskWithResult<void> task_;
};

} // namespace six_feat
