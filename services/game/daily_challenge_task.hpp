#pragma once

// ════════════════════════════════════════════════════════════════════════════
// daily_challenge_task.hpp — [SF-GAME-16] Once-a-day background publisher for
// kind="daily" challenges.
//
// Same "hand-rolled coroutine + InterruptibleSleepFor + RequestCancel on
// shutdown" shape as PruneTask (libs/six-feat-common/src/enrichment/
// prune_task.hpp) — this repo has no userver::utils::PeriodicTask usage
// anywhere, that shape is the established idiom for "run X periodically"
// here. Unlike PruneTask (opt-in via an env var), this one is always on:
// there's no operational reason to disable it, and it's cheap/idempotent
// (a run that can't find an "interesting" pair just logs and retries next
// interval, per RunOnce's own doc-comment).
//
// Picks a random pair from artists six-feat already has L1 credit data for
// (GameStore::RandomArtistIdsWithCredits), runs the same pure-L1 BFS
// challenge-creation uses (ideal_finder.hpp), and — if the resulting path is
// at least min-path-len hops (a direct 1-hop pair isn't "interesting" for a
// daily challenge) — publishes it via GameStore::UpsertChallenge with
// kind="daily". Retries with a different random pair (up to max-attempts)
// within one pass if a candidate turns out too short/disconnected, rather
// than giving up on the very first miss.
//
// [fix] kind is the literal fixed string "daily" per the ticket, not date-
// scoped (e.g. "daily-2026-07-20") — the UNIQUE (from, to, role_mask, kind)
// constraint from SF-GAME-11 means if the random picker ever lands on a pair
// that's already a "daily" challenge from an earlier run, this just
// reconfirms that same existing row rather than minting a rotating new one.
// Documented as a deliberate, minimal reading of the ticket's literal
// wording, not an oversight — a real per-day rotation scheme (distinct kind
// per calendar day, an explicit "today's challenge" lookup) is a bigger,
// unrequested feature this ticket doesn't ask for.
// ════════════════════════════════════════════════════════════════════════════

#include <chrono>
#include <string_view>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;
class NeighboursClient;

class DailyChallengeTask final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "daily-challenge-task";

    DailyChallengeTask(const userver::components::ComponentConfig&  config,
                       const userver::components::ComponentContext& context);

    ~DailyChallengeTask() override;

    void OnAllComponentsLoaded() override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    void Loop();
    // One publish attempt: true if a daily challenge was (re)confirmed,
    // false if it gave up this pass (no candidate pair within max-attempts
    // produced a path >= min-path-len) — logged, not fatal, retried on the
    // next interval.
    bool RunOnce();

    GameStore&               store_;
    const NeighboursClient&  neighbours_;
    const std::chrono::seconds interval_;
    const int                min_path_len_;
    const int                max_attempts_;
    const int                candidate_pool_size_;

    userver::engine::TaskProcessor&        main_tp_;
    userver::engine::TaskWithResult<void>  task_;
};

} // namespace six_feat::game
