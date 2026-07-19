#pragma once

// ════════════════════════════════════════════════════════════════════════════
// game_store.hpp — [SF-GAME-11] Durable store for the game_* schema.
//
// The game service's own persistence component, modeled on
// libs/six-feat-common/src/storage/persistent_store.{hpp,cpp}: it attaches to
// the shared Postgres cluster (the same postgres-db-1 component six-feat/
// enrichment use — game_* tables live alongside the existing schema in the
// same database) and owns its OWN forward-only migration registry
// (game_migrations, see game_store.cpp), gated by a DEDICATED
// `game_schema_version` table so it never collides with six-feat's own
// `schema_version` in that same database.
//
// SF-GAME-11 scope is schema + migrations + a readiness ping only — the
// query API (profiles, challenges, attempts, leaderboards) lands with the
// tickets that need it (SF-GAME-12 onward). Migrations run in the background
// (OnAllComponentsLoaded), same as PersistentStore, so an unreachable
// Postgres at boot never blocks the HTTP listener from starting; /readyz
// reflects live DB reachability via Ping().
// ════════════════════════════════════════════════════════════════════════════

#include <memory>
#include <string_view>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "game-store";

    GameStore(const userver::components::ComponentConfig&  config,
              const userver::components::ComponentContext& context);

    ~GameStore() override;

    // Migrations run here (detached on main-task-processor), not in the
    // constructor — same rationale as PersistentStore::OnAllComponentsLoaded:
    // a slow/unreachable Postgres must not block component startup / the HTTP
    // listener. See game_store.cpp.
    void OnAllComponentsLoaded() override;

    // Readiness probe: "SELECT 1" against the cluster. Returns false (never
    // throws) if the DB is unreachable — drives /readyz's "database" check
    // (see internal_handlers.cpp).
    bool Ping() const;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    struct Impl;
    userver::engine::TaskProcessor&        main_tp_;
    std::unique_ptr<Impl>                  impl_;
    // Declared after impl_ so its destructor (reverse declaration order) runs
    // FIRST — cancels/joins the background migration task before impl_'s
    // cluster is torn down. Same pattern PersistentStore uses.
    userver::engine::TaskWithResult<void>  migration_task_;
};

} // namespace six_feat::game
