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
#include <utility>
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

// [SF-GAME-18] A game_seasons row — a fixed-length (30-day), non-overlapping
// window that challenges get stamped with at creation time (see
// EnsureCurrentSeason) so game_attempts.season_id (denormalized at submit
// time, SF-GAME-17) can drive a season-scoped leaderboard the exact same way
// a single challenge's leaderboard already works — GetLeaderboard has taken
// LeaderboardScope::kSeason since SF-GAME-11/17, this is what finally
// populates season_id instead of it staying nullopt forever.
struct Season {
    std::int64_t id{0};
    std::string  name;
    std::int64_t starts_ts{0};
    std::int64_t ends_ts{0};
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
    // [SF-GAME-18] Denormalized onto game_attempts at submit time (see
    // RecordValidAttempt) so the season leaderboard is a direct
    // (season_id, score DESC) index scan — SF-GAME-11's own third index.
    // Set once, at creation (EnsureCurrentSeason), same "never overwrite an
    // already-computed value" posture as optimal_len/optimal_path — a
    // challenge keeps the season it was born in even once that season ends.
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
    // [SF-GAME-19] The profile's games count AFTER this attempt (i.e.
    // INCLUDING it) — 1 means this was the player's first-ever valid
    // attempt, feeding EvaluateAndAwardAchievements' "first_win"/"veteran"
    // rules without a second round-trip to game_profiles.
    int games_after{0};
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
    // [SF-GAME-18] The row's ACTUAL stored season_id — on a pre-existing
    // challenge this is whatever season it was born in, not necessarily the
    // season_id this same call passed in (which only takes effect on a
    // fresh insert).
    std::optional<std::int64_t> season_id;
};

// [design: challenge setup on the landing page] A resolved artist reference
// (id + display name + optional image) — used only where a caller needs to
// SHOW a challenge, not just resume one by id. Read straight off six-feat's
// own `artists` table (see ResolveArtistNames' own comment for why that's a
// legitimate direct read from this service).
struct ArtistRef {
    std::int64_t               id{0};
    std::string                 name;
    std::optional<std::string> image_url;
};

// [design: challenge setup on the landing page] The most recent kind='daily'
// challenge, PLUS its endpoints resolved to real names/images — everything
// the landing page's "Today's Challenge" card needs to render without a
// second round-trip anywhere (the plain Challenge/GetChallenge pair only
// carries numeric artist ids, fine for resuming a challenge you already
// picked, useless for DISPLAYING one you haven't).
struct DailyChallengeView {
    Challenge  challenge;
    ArtistRef  from;
    ArtistRef  to;
};

// [game #3] One row of the challenge browser — a challenge plus its endpoints
// resolved to names/images (same shape as DailyChallengeView) and its
// creation timestamp (for keyset pagination + a "created" display).
struct ChallengeListItem {
    Challenge    challenge;
    ArtistRef    from;
    ArtistRef    to;
    std::int64_t created_ts{0};
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
    // [SF-GAME-53] Рейтинг игрока. У сезонной доски он и есть ключ сортировки
    // (см. GetLeaderboard), у доски челленджа — просто справка «кто это».
    int          elo{0};
    // Сыгранных партий. Осмысленно только у сезонной строки: у строки
    // челленджа это одна конкретная попытка, считать там нечего.
    int          games{0};
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

// [SF-GAME-19] One earned game_user_achievements row, joined against its
// game_achievements catalog entry — everything ProfileHandler needs to
// render it without a second lookup.
struct Achievement {
    std::string  code;
    std::string  title;
    std::string  descr;
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

    // [SF-GAME-19] Achievement rule-engine — called once, right after
    // RecordValidAttempt, with that SAME call's own result (never
    // re-queried, so the rules see exactly what was just persisted).
    // Evaluates the fixed catalog (game_achievements, seeded by
    // kGameMigrationV2) against this one attempt + the player's now-current
    // stats, awards (INSERT ... ON CONFLICT DO NOTHING) whichever rules
    // newly match, and returns only the codes that were ACTUALLY newly
    // inserted this call — a rule matching again on a later attempt is a
    // no-op, not a duplicate award, and isn't in the returned list either
    // time after the first.
    std::vector<std::string> EvaluateAndAwardAchievements(
        std::int64_t user_id, const SubmitResult& outcome,
        std::optional<int> elapsed_ms) const;

    // [game #4] The full achievement catalog (every game_achievements row),
    // independent of any user — powers the Season & Achievements wall's
    // "locked" tiles (the ones nobody's earned yet still need a title/descr to
    // render). Same {code,title,descr} shape as ListAchievements; ts is always
    // 0 (a catalog entry has no earn time). Ordered by code for a stable,
    // deterministic render order.
    std::vector<Achievement> ListAchievementCatalog() const;

    // [SF-GAME-19] This player's earned achievements (code/title/descr,
    // joined against the catalog) — feeds the public profile lookup
    // (profile_handler.cpp's ?user= branch).
    std::vector<Achievement> ListAchievements(std::int64_t user_id) const;

    // [SF-GAME-18] Season lifecycle API.

    // Returns the currently active season (by wall-clock time), creating one
    // if none is active yet. Seasons are fixed 30-day, non-overlapping
    // windows anchored at a fixed epoch (see game_store.cpp) — deterministic
    // boundaries mean two concurrent callers computing "now"'s window always
    // agree on its [starts_ts, ends_ts), so the EXCLUSIVE-lock transaction
    // that guards the actual insert (same pattern RunGameMigrations uses on
    // game_schema_version) only ever needs to break a literal race, never a
    // logical one. Never returns nullopt — a season always exists once this
    // has been called at least once, and it self-heals if wall-clock time
    // ever moves past ends_ts before this is called again.
    Season EnsureCurrentSeason() const;

    // [SF-GAME-16] Challenge lifecycle API.

    // Creates the (from, to, role_mask, kind) challenge if it doesn't exist
    // yet (the UNIQUE constraint from SF-GAME-11's migration), or returns
    // the existing one unchanged — NEVER overwrites an already-computed
    // optimal_len/optimal_path OR season_id. created_by is only stored on a
    // genuine insert (nullable — a daily challenge has no player creator).
    // [SF-GAME-18] season_id is the CURRENT season's id (EnsureCurrentSeason)
    // at creation time — pass it straight through, same "never invent one"
    // convention RecordValidAttempt's own season_id param already documents.
    ChallengeUpsertResult UpsertChallenge(std::int64_t from_artist_id,
                                          std::int64_t to_artist_id,
                                          int role_mask, const std::string& kind,
                                          std::optional<std::int64_t> created_by,
                                          std::optional<std::int64_t> season_id) const;

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

    // [design: challenge setup on the landing page] The most recently
    // published kind='daily' challenge (by created_ts, same ordering
    // test_game_challenge.py's own _daily_challenge_row already reads by),
    // with its from/to artist ids resolved to names/images against
    // six-feat's own `artists` table — same "same Postgres database, legit
    // direct read" posture as RandomArtistIdsWithCredits above. nullopt if
    // no daily challenge has ever been published in this environment yet
    // (a fresh stack, before DailyChallengeTask's first pass) — the caller
    // maps that to 404, not an empty/fake body.
    std::optional<DailyChallengeView> GetLatestDailyChallenge() const;

    // [game #3] Recent PLAYABLE challenges (optimal_len computed) for the
    // challenge-browser window, newest first, endpoints resolved to names/
    // images. `kind` filters to "daily"/"custom" (empty = all). Keyset
    // pagination on (created_ts, id) DESC: pass the last item's created_ts +
    // id as the cursor to get the next page; nullopt cursor starts from the
    // newest. `limit` is clamped by the caller (challenges_handler.cpp).
    // [SF-GAME-46] `query` — подстрочный поиск по имени артиста на ЛЮБОМ конце
    // пары (пусто = без фильтра). Игрок ищет «челлендж с Дрейком», не зная,
    // старт он там или цель.
    std::vector<ChallengeListItem> ListChallenges(
        const std::string& kind,
        const std::string& query,
        std::optional<std::pair<std::int64_t, std::int64_t>> cursor,
        int limit) const;

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
