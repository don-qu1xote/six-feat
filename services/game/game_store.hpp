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
    // [SF-GAME-17] Denormalized onto game_attempts at submit time (see
    // RecordValidAttempt) so the season leaderboard is a direct
    // (season_id, score DESC) index scan — SF-GAME-11's own third index.
    // nullopt for every challenge today: nothing creates a game_seasons row
    // yet (no season-management ticket exists), so this is wired correctly
    // for when one does, not exercised by anything yet.
    std::optional<std::int64_t> season_id;
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

// [SF-GAME-16] Result of UpsertChallenge: `created` is true only when this
// call actually inserted a NEW row (Postgres's `xmax = 0` trick — see
// game_store.cpp) — false means the (from, to, role_mask, kind) tuple
// already existed and this is that same row, per the ticket's "повторный
// create отдаёт тот же [id]" requirement. optimal_len/optimal_path are
// whatever was already stored (nullopt/empty for a brand new row, or for an
// existing one whose ideal hasn't been computed yet).
struct ChallengeUpsertResult {
    std::int64_t               id{0};
    bool                        created{false};
    std::optional<int>         optimal_len;
    std::vector<std::int64_t>  optimal_path;
};

// [SF-GAME-17] One entry in a leaderboard page — a player's BEST valid
// attempt within the scope (challenge or season), not every attempt they
// ever made (see GetLeaderboard's own comment for why).
struct LeaderboardEntry {
    std::int64_t user_id{0};
    std::string  display_name;
    int          score{0};
    int          hops{0};
    std::int64_t ts{0};
};

struct LeaderboardPage {
    std::vector<LeaderboardEntry> entries;
    // Opaque "score:attempt_id" cursor for the next page, or nullopt when
    // `entries` already reached the end of the leaderboard.
    std::optional<std::string> next_cursor;
};

enum class LeaderboardScope { kChallenge, kSeason };

// [SF-GAME-17] One row of a player's attempt history (ProfileHandler's
// public ?user= lookup).
struct AttemptSummary {
    std::int64_t challenge_id{0};
    bool         valid{false};
    int          score{0};
    int          hops{0};
    std::int64_t ts{0};
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

    // [SF-GAME-17] Read-only profile lookup for the PUBLIC ?user= endpoint
    // (profile_handler.cpp) — unlike EnsureAndGetProfile, NEVER creates a
    // row: looking up an arbitrary user_id that happens to not exist yet
    // shouldn't conjure a profile into being. nullopt if there's no such
    // profile (the handler maps that to 404).
    std::optional<Profile> GetProfileIfExists(std::int64_t user_id) const;

    // Up to `limit` of this player's most recent attempts (valid or not),
    // newest first — the "история" (history) half of the public profile
    // lookup.
    std::vector<AttemptSummary> ListRecentAttempts(std::int64_t user_id, int limit) const;

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
    // [SF-GAME-17] season_id is the challenge's OWN season_id (denormalized
    // onto the attempt row so the season leaderboard is a direct index
    // scan) — pass challenge.season_id straight through, never invent one.
    SubmitResult RecordValidAttempt(std::int64_t user_id, std::int64_t challenge_id,
                                    const std::vector<std::int64_t>& chain,
                                    int optimal_len,
                                    std::optional<int> elapsed_ms,
                                    std::optional<std::int64_t> season_id) const;

    // [SF-GAME-16] Challenge lifecycle API.

    // Creates the (from, to, role_mask, kind) challenge if it doesn't exist
    // yet (the UNIQUE constraint from SF-GAME-11's migration), or returns
    // the existing one unchanged — NEVER overwrites an already-computed
    // optimal_len/optimal_path. created_by is only stored on a genuine
    // insert (nullable — a daily challenge has no player creator).
    ChallengeUpsertResult UpsertChallenge(std::int64_t from_artist_id,
                                          std::int64_t to_artist_id,
                                          int role_mask, const std::string& kind,
                                          std::optional<std::int64_t> created_by) const;

    // Fills in optimal_len/optimal_path for a challenge whose ideal hasn't
    // been computed yet. A no-op (returns false) if it's already set — an
    // ideal is computed once and never recomputed, so repeated create/get
    // calls on the same pair only pay for the BFS on the very first one
    // that doesn't already have L1 data covering it.
    bool SetChallengeIdeal(std::int64_t challenge_id, int optimal_len,
                          const std::vector<std::int64_t>& optimal_path) const;

    // [SF-GAME-16 daily task] Up to `limit` distinct artist ids with at
    // least one L1 credit row, in random order — the candidate pool the
    // daily-challenge task draws a "from"/"to" pair from. Reads six-feat's
    // own artists/credits tables directly: legitimate because game-store
    // and six-feat share the exact same Postgres database (see this
    // component's own module comment) — no network hop for a read this
    // cheap and this infrequent (once a day).
    std::vector<std::int64_t> RandomArtistIdsWithCredits(int limit) const;

    // [SF-GAME-17] Leaderboard read API.

    // One page of the top attempts within `scope_id` (a challenge_id or a
    // season_id, per `scope`), ranked by score descending, ONE ENTRY PER
    // PLAYER — their single best valid attempt in scope, not every attempt
    // they ever submitted (so a player who retried 50 times doesn't flood
    // their own top-N with duplicates). `cursor`, when set, must be exactly
    // what a previous call's `next_cursor` returned; nullopt starts from
    // the top. `limit` is clamped to a sane range by the caller
    // (leaderboard_handler.cpp), not here.
    LeaderboardPage GetLeaderboard(LeaderboardScope scope, std::int64_t scope_id,
                                  const std::optional<std::string>& cursor,
                                  int limit) const;

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
