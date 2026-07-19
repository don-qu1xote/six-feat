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

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

// [SF-GAME-12] A player's game profile row (game_profiles) plus their computed
// leaderboard rank (1-based, by elo descending).
struct Profile {
    std::int64_t user_id{0};
    std::string  display_name;
    std::string  avatar_url;
    int          elo{0};
    int          games{0};
    int          rank{0};
};

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

    // [SF-GAME-12] Profile API. Throw storages::postgres::Error on a DB
    // failure (the handler maps that to 5xx); never on "row absent".

    // Creates the profile on first sight (INSERT ... ON CONFLICT DO NOTHING,
    // defaults from game_migrations: elo=1200, games=0), then returns it with
    // its current leaderboard rank filled in. The *_default args are used only
    // when the row is created — an existing row keeps its stored values.
    Profile EnsureAndGetProfile(std::int64_t user_id,
                                const std::string& display_name_default,
                                const std::string& avatar_url_default) const;

    // Updates an existing profile's display name and returns the refreshed
    // Profile (with rank). The caller ensures the row exists first
    // (EnsureAndGetProfile) — this is a plain UPDATE ... RETURNING.
    Profile SetDisplayName(std::int64_t user_id, const std::string& display_name) const;

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
