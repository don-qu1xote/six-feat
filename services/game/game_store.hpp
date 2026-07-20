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
#include <optional>
#include <string>
#include <string_view>
#include <vector>

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

// [SF-GAME-15] A game_challenges row. optimal_len/optimal_path are nullopt/
// empty until whatever creates the challenge (SF-GAME-16) computes and
// stores our own BFS ideal — GetChallenge returns them as-is either way;
// callers decide what "not computed yet" means for them (submit_handler.cpp
// treats it as 409, not a 404 or a silently-unscored attempt).
struct Challenge {
    std::int64_t               id{0};
    std::int64_t                from_artist_id{0};
    std::int64_t                to_artist_id{0};
    int                          role_mask{0};
    std::string                  kind;
    std::optional<int>           optimal_len;
    std::vector<std::int64_t>    optimal_path;
};

// [SF-GAME-15] Result of scoring + applying a valid, chain_validator-
// confirmed attempt. elo_delta is elo_after - elo_before, kept explicit
// rather than left for the caller to subtract (avoids ever disagreeing with
// the transaction that actually computed it).
struct SubmitResult {
    int player_len{0};
    int score{0};
    int max_score{0};
    int elo_before{0};
    int elo_after{0};
    int elo_delta{0};
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

    // [SF-GAME-15] Challenge + submission API.

    // nullopt if no challenge with this id exists. Never throws on "row
    // absent" — only on a genuine DB failure.
    std::optional<Challenge> GetChallenge(std::int64_t challenge_id) const;

    // Records a chain_validator-CONFIRMED-invalid attempt: no scoring, no
    // Elo change — just persisted so it counts toward a later valid
    // attempt's prior_attempts penalty (see scoring.hpp).
    void RecordInvalidAttempt(std::int64_t user_id, std::int64_t challenge_id,
                              const std::vector<std::int64_t>& chain) const;

    // Records a chain_validator-CONFIRMED-valid attempt: computes score
    // (scoring.hpp::ComputeScore, using this challenge's optimal_len, the
    // submitted chain's length, and this user's prior attempt count on this
    // SAME challenge — queried inside the same transaction) and the
    // resulting Elo update, then persists the attempt row and the profile's
    // new elo/games count in ONE transaction — the ticket's explicit
    // requirement, so a crash between the two can never leave them
    // disagreeing. The caller ensures the profile row exists first
    // (EnsureAndGetProfile), same convention as SetDisplayName.
    SubmitResult RecordValidAttempt(std::int64_t user_id, std::int64_t challenge_id,
                                    const std::vector<std::int64_t>& chain,
                                    int optimal_len,
                                    std::optional<int> elapsed_ms) const;

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
