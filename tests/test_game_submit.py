"""
test_game_submit.py — [SF-GAME-15] integration tests for the game service's
POST /api/v1/game/submit (scoring + Elo update against a challenge's ideal).

Same harness convention as test_game_validate.py (SF-GAME-14): the game
service needs Postgres AND a reachable six-feat instance (for the
/internal/neighbours lookup chain_validator.hpp delegates to), so these run
against the running docker-compose stack via GAME_SERVICE_ORIGIN, self-
skipping if that origin isn't reachable. Real L1 collaboration data AND a
game_challenges row (with optimal_len/optimal_path already computed) are
seeded directly via psycopg2 — there is no challenge-creation endpoint yet
(that's SF-GAME-16), so a fully-formed challenge row is the mock "ideal" the
ticket asks these tests to score a mock attempt against.

The score/Elo arithmetic (_expected_score/_expected_elo below) is a literal
reimplementation of services/game/scoring.hpp's ComputeScore/UpdateElo in
Python — the same "two independent sources of truth" pattern
test_contract_gateway.py already uses — so these tests fail immediately and
specifically if the two ever drift, rather than only noticing a vague score
mismatch.

Scenarios (per the ticket):
  1. no cookie -> 401.
  2. malformed body / missing challenge_id / chain shorter than 2 -> 400.
  3. unknown challenge_id -> 404.
  4. a challenge whose ideal hasn't been computed yet (optimal_len IS NULL)
     -> 409.
  5. exact-optimal valid chain, fresh player -> score/Elo delta match the
     Python reimplementation exactly (deterministic).
  6. a longer-than-optimal valid chain -> extra-hop penalty applied.
  7. a fabricated hop -> {valid:false, ...}, no score, no Elo change,
     recorded so it counts toward a LATER valid submission's prior_attempts
     penalty ("невалид снижают").
  8. two valid submissions by the same player on the same challenge -> the
     second one's score/Elo reflect prior_attempts=1.
  9. [SF-GAME-36] anti-abuse: a REPEAT submission of the same challenge is
     still scored, but never re-rates — Elo and the games count both stay put,
     however many times it's replayed. The gate is per (player, challenge), so
     a different challenge still rates normally.
"""

from __future__ import annotations

import math
import os
import time

import psycopg2
import pytest
import requests

import session_crypto

TEST_APP_SECRET = "f" * 64  # same as tests/conftest.py's TEST_APP_SECRET
ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
SUBMIT_URL = f"{ORIGIN}/api/v1/game/submit"

pytestmark = pytest.mark.game_submit

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

# Role encoding — matches persistent_store.cpp's RoleToInt/kMigrationV1.
ROLE_PRIMARY = 1
ROLE_FEATURED = 2

# A dedicated, SF-GAME-15-themed id block, disjoint from
# test_game_validate.py's 140_00x range.
_A_ID, _B_ID, _Y_ID, _X_ID = 150_001, 150_002, 150_003, 150_004

# ── scoring.hpp reimplementation (must stay byte-for-byte in sync) ─────────

MAX_SCORE = 1000
LEN_PENALTY_PER_HOP = 100
ATTEMPT_PENALTY_PER_PRIOR = 50
TIME_FREE_BUDGET_MS = 30000
TIME_BUCKET_MS = 2000
TIME_PENALTY_PER_BUCKET = 1

BASE_CHALLENGE_RATING = 1200
RATING_PER_OPTIMAL_HOP = 60
ELO_DIVISOR = 400.0
ELO_K = 24
MIN_RATING = 100


def _expected_score(optimal_len: int, player_len: int, prior_attempts: int,
                     elapsed_ms: int | None = None) -> int:
    score = MAX_SCORE
    score -= max(0, player_len - optimal_len) * LEN_PENALTY_PER_HOP
    score -= max(0, prior_attempts) * ATTEMPT_PENALTY_PER_PRIOR
    if elapsed_ms is not None and elapsed_ms > TIME_FREE_BUDGET_MS:
        over = elapsed_ms - TIME_FREE_BUDGET_MS
        score -= (over // TIME_BUCKET_MS) * TIME_PENALTY_PER_BUCKET
    return max(0, min(MAX_SCORE, score))


def _lround(x: float) -> int:
    # std::lround: round half away from zero (Python's round() is
    # round-half-to-even, which disagrees exactly at .5 boundaries).
    return math.floor(x + 0.5) if x >= 0 else -math.floor(-x + 0.5)


def _expected_elo(player_rating: int, optimal_len: int, score: int,
                   max_score: int = MAX_SCORE) -> tuple[int, int]:
    challenge_rating = BASE_CHALLENGE_RATING + optimal_len * RATING_PER_OPTIMAL_HOP
    expected = 1.0 / (1.0 + 10 ** ((challenge_rating - player_rating) / ELO_DIVISOR))
    result = (score / max_score) if max_score > 0 else 0.0
    delta = _lround(ELO_K * (result - expected))
    return delta, max(MIN_RATING, player_rating + delta)


# ── seeding helpers ─────────────────────────────────────────────────────────

def _seed_collaboration(song_id: int, title: str, members: list[tuple[int, str, int]]) -> None:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            for artist_id, name, _role in members:
                cur.execute(
                    "INSERT INTO artists (id, name, image_url, url) VALUES (%s, %s, '', '') "
                    "ON CONFLICT (id) DO NOTHING",
                    (artist_id, name),
                )
            cur.execute(
                "INSERT INTO songs (id, title) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                (song_id, title),
            )
            for artist_id, _name, role in members:
                cur.execute(
                    "INSERT INTO credits (song_id, artist_id, role) VALUES (%s, %s, %s) "
                    "ON CONFLICT (song_id, artist_id, role) DO NOTHING",
                    (song_id, artist_id, role),
                )
    finally:
        conn.close()


def _seed_challenge(from_id: int, to_id: int, role_mask: int, kind: str,
                     optimal_len: int | None, optimal_path: list[int] | None) -> int:
    """Directly writes a game_challenges row with its ideal already computed
    — there is no challenge-creation endpoint yet (SF-GAME-16), so this
    stands in as the "mock ideal" the ticket's pytest requirement asks for."""
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO game_challenges "
                "(from_artist_id, to_artist_id, role_mask, kind, optimal_len, optimal_path, created_ts) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (from_artist_id, to_artist_id, role_mask, kind) "
                "DO UPDATE SET optimal_len = EXCLUDED.optimal_len, "
                "              optimal_path = EXCLUDED.optimal_path "
                "RETURNING id",
                (from_id, to_id, role_mask, kind, optimal_len, optimal_path, int(time.time())),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def _fresh_cookie() -> tuple[str, str]:
    """A never-before-seen player name (and its cookie) — StableUserId(name)
    hashes to a fresh user_id, so game_profiles starts this player at the
    migration defaults (elo=1200, games=0) regardless of what earlier test
    runs left in the shared, persisted docker-compose Postgres."""
    name = f"SFGAME15Player-{time.time_ns()}"
    return name, session_crypto.make_cookie(
        TEST_APP_SECRET, access_token="test-genius-access-token",
        ttl_seconds=3600, name=name,
    )


def _skip_if_unreachable() -> None:
    try:
        requests.post(SUBMIT_URL, json={}, timeout=2)
    except requests.exceptions.RequestException:
        pytest.skip(f"game service not reachable at {ORIGIN} — start docker compose")
    try:
        conn = psycopg2.connect(**DB_CONN_PARAMS, connect_timeout=2)
        conn.close()
    except psycopg2.OperationalError:
        pytest.skip(f"Postgres not reachable with {DB_CONN_PARAMS} — start docker compose")


@pytest.fixture(scope="module", autouse=True)
def _require_service() -> None:
    _skip_if_unreachable()


@pytest.fixture(scope="module")
def direct_challenge_id() -> int:
    """A: primary, B: featured, sharing one song -> A-B direct hop is real
    and is also the shortest possible path (optimal_len=1)."""
    _seed_collaboration(
        150_101, "SF-GAME-15 Direct Collab",
        [(_A_ID, "SFGAME15ArtistA", ROLE_PRIMARY), (_B_ID, "SFGAME15ArtistB", ROLE_FEATURED)],
    )
    # A second, longer real path through Y (for the extra-hops-penalty test):
    # A-Y and Y-B are each real, independent of the direct A-B collab above.
    _seed_collaboration(
        150_102, "SF-GAME-15 A-Y Collab",
        [(_A_ID, "SFGAME15ArtistA", ROLE_PRIMARY), (_Y_ID, "SFGAME15ArtistY", ROLE_FEATURED)],
    )
    _seed_collaboration(
        150_103, "SF-GAME-15 Y-B Collab",
        [(_Y_ID, "SFGAME15ArtistY", ROLE_PRIMARY), (_B_ID, "SFGAME15ArtistB", ROLE_FEATURED)],
    )
    # X exists but shares nothing with B — the fabricated-hop test target.
    _seed_collaboration(
        150_104, "SF-GAME-15 Unrelated Collab",
        [(_X_ID, "SFGAME15ArtistX", ROLE_PRIMARY), (_A_ID, "SFGAME15ArtistA", ROLE_FEATURED)],
    )
    return _seed_challenge(_A_ID, _B_ID, 15, "sf-game-15-direct", optimal_len=1, optimal_path=[_A_ID, _B_ID])


@pytest.fixture(scope="module")
def second_challenge_id(direct_challenge_id: int) -> int:
    """[SF-GAME-36] A genuinely DIFFERENT challenge (A->Y, also a real direct
    hop seeded by direct_challenge_id above), so the anti-abuse rule can be
    shown to be per (player, challenge) rather than "only your first game ever
    counts". Depends on direct_challenge_id purely for its collaboration
    seeding."""
    return _seed_challenge(_A_ID, _Y_ID, 15, "sf-game-36-second",
                           optimal_len=1, optimal_path=[_A_ID, _Y_ID])


@pytest.fixture(scope="module")
def unscored_challenge_id() -> int:
    """A challenge whose ideal hasn't been computed yet (optimal_len IS
    NULL) — simulates a row SF-GAME-16 hasn't finished processing."""
    return _seed_challenge(_X_ID, _B_ID, 15, "sf-game-15-unscored", optimal_len=None, optimal_path=None)


def _post(cookie: str | None, body: dict):
    sess = requests.Session()
    if cookie is not None:
        sess.cookies.update({"six_feat_session": cookie})
    return sess.post(SUBMIT_URL, json=body, timeout=5)


def test_no_cookie_returns_401(direct_challenge_id: int):
    resp = _post(None, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]})
    assert resp.status_code == 401
    assert "application/problem+json" in resp.headers.get("Content-Type", "")


def test_malformed_body_returns_400():
    _, cookie = _fresh_cookie()
    resp = _post(cookie, {"challenge_id": "nope", "chain": "nope"})
    assert resp.status_code == 400


def test_missing_challenge_id_returns_400():
    _, cookie = _fresh_cookie()
    resp = _post(cookie, {"chain": [_A_ID, _B_ID]})
    assert resp.status_code == 400


def test_chain_shorter_than_two_returns_400(direct_challenge_id: int):
    _, cookie = _fresh_cookie()
    resp = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID]})
    assert resp.status_code == 400


def test_unknown_challenge_id_returns_404():
    _, cookie = _fresh_cookie()
    resp = _post(cookie, {"challenge_id": 999_999_999, "chain": [_A_ID, _B_ID]})
    assert resp.status_code == 404


def test_challenge_without_computed_ideal_returns_409(unscored_challenge_id: int):
    _, cookie = _fresh_cookie()
    resp = _post(cookie, {"challenge_id": unscored_challenge_id, "chain": [_X_ID, _B_ID]})
    assert resp.status_code == 409


def test_exact_optimal_chain_scores_max_and_matches_expected_elo(direct_challenge_id: int):
    _, cookie = _fresh_cookie()
    resp = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    assert body["player_len"] == 1
    assert body["optimal_len"] == 1
    assert body["optimal_path"] == [_A_ID, _B_ID]  # the ideal, revealed only now

    expected_score = _expected_score(optimal_len=1, player_len=1, prior_attempts=0)
    assert expected_score == MAX_SCORE
    assert body["score"] == expected_score
    assert body["max_score"] == MAX_SCORE
    assert body["elo_before"] == 1200  # fresh profile, migration default

    expected_delta, expected_new = _expected_elo(1200, optimal_len=1, score=expected_score)
    assert body["elo_delta"] == expected_delta
    assert body["elo_after"] == expected_new


def test_first_perfect_submit_unlocks_achievements_once(direct_challenge_id: int):
    # [SF-GAME-19] A brand-new player's first submit, solved exactly
    # optimally, must unlock BOTH "first_win" (games_after == 1) and
    # "perfect_solve" (score == max_score) — and never again on a repeat.
    _, cookie = _fresh_cookie()
    first = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]})
    assert first.status_code == 200
    unlocked = set(first.json().get("achievements_unlocked", []))
    assert {"first_win", "perfect_solve"} <= unlocked

    second = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]})
    assert second.status_code == 200
    # Not the FIRST win anymore, and this repeat's score is penalized (see
    # test_prior_attempts_reduce_a_later_valid_submissions_score below) so
    # it's not a perfect solve either — nothing new to unlock.
    assert second.json().get("achievements_unlocked", []) == []


def test_longer_valid_chain_applies_extra_hop_penalty(direct_challenge_id: int):
    _, cookie = _fresh_cookie()
    resp = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _Y_ID, _B_ID]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    assert body["player_len"] == 2
    assert body["optimal_len"] == 1

    expected_score = _expected_score(optimal_len=1, player_len=2, prior_attempts=0)
    assert expected_score == MAX_SCORE - LEN_PENALTY_PER_HOP
    assert body["score"] == expected_score

    expected_delta, expected_new = _expected_elo(1200, optimal_len=1, score=expected_score)
    assert body["elo_delta"] == expected_delta
    assert body["elo_after"] == expected_new


def test_fabricated_hop_is_rejected_and_untouched_by_scoring(direct_challenge_id: int):
    _, cookie = _fresh_cookie()
    # A->X is real; X->B is NOT (seeded with no shared song).
    resp = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _X_ID, _B_ID]})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"valid": False, "reason": "invalid_hop", "invalid_hop_index": 1}
    assert "score" not in body
    assert "elo_after" not in body


def test_prior_attempts_reduce_a_later_valid_submissions_score(direct_challenge_id: int):
    _, cookie = _fresh_cookie()
    first = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]}).json()
    assert first["score"] == MAX_SCORE  # prior_attempts=0

    second = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]}).json()
    expected_score = _expected_score(optimal_len=1, player_len=1, prior_attempts=1)
    assert expected_score == MAX_SCORE - ATTEMPT_PENALTY_PER_PRIOR
    assert second["score"] == expected_score
    # Elo continuity: the second submit's "before" is the first submit's "after".
    assert second["elo_before"] == first["elo_after"]


def test_invalid_attempt_counts_toward_prior_attempts_too(direct_challenge_id: int):
    _, cookie = _fresh_cookie()
    invalid = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _X_ID, _B_ID]}).json()
    assert invalid["valid"] is False

    valid = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]}).json()
    expected_score = _expected_score(optimal_len=1, player_len=1, prior_attempts=1)
    assert expected_score == MAX_SCORE - ATTEMPT_PENALTY_PER_PRIOR
    assert valid["score"] == expected_score


# ── [SF-GAME-36] Anti-abuse: only the FIRST valid attempt is ranked ───────────
# The two tests above pin the SCORE side of a repeat (each prior attempt costs
# ATTEMPT_PENALTY_PER_PRIOR). They do NOT pin the anti-abuse property itself:
# that a repeat submission moves neither the player's Elo nor their games
# count. Without that, re-submitting the same optimal line would let a player
# farm rating forever — the score decay alone doesn't stop it, since a decayed
# score can still be an Elo gain. See game_store.cpp's `ranked` flag.


def _profile_row(name: str) -> tuple[int, int]:
    """(elo, games) straight from game_profiles for this player, keyed by the
    same FNV-1a hash of the Genius name that game_session.hpp's StableUserId
    computes — an independent Python reimplementation, same "two sources of
    truth" posture as _expected_score/_expected_elo above."""
    h = 1469598103934665603
    for byte in name.encode():
        h ^= byte
        h = (h * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    user_id = h & 0x7FFFFFFFFFFFFFFF

    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT elo, games FROM game_profiles WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            return (row[0], row[1]) if row else (0, 0)
    finally:
        conn.close()


def test_repeat_submission_never_moves_elo(direct_challenge_id: int):
    """A replayed challenge is scored (and shown) but never re-rates."""
    _, cookie = _fresh_cookie()
    body = {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]}

    first = _post(cookie, body).json()
    assert first["elo_delta"] != 0, "the first valid attempt must actually rate"
    settled = first["elo_after"]

    second = _post(cookie, body).json()
    assert second["valid"] is True          # still a real, accepted chain
    assert second["score"] > 0              # still scored (decayed, see test above)
    assert second["elo_delta"] == 0         # ...but never rated again
    assert second["elo_before"] == settled
    assert second["elo_after"] == settled

    third = _post(cookie, body).json()
    assert third["elo_after"] == settled, "Elo must not drift on further replays"


def test_repeat_submission_never_increments_games(direct_challenge_id: int):
    """games counts RANKED attempts, so a replay leaves it where it was."""
    name, cookie = _fresh_cookie()
    body = {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]}

    _post(cookie, body)
    elo_after_first, games_after_first = _profile_row(name)
    assert games_after_first == 1

    _post(cookie, body)
    _post(cookie, body)
    elo_now, games_now = _profile_row(name)
    assert games_now == 1, "replays must not inflate the games count"
    assert elo_now == elo_after_first, "replays must not inflate Elo"


def test_a_different_challenge_still_rates_normally(direct_challenge_id: int,
                                                    second_challenge_id: int):
    """The gate is per (player, challenge) — a NEW challenge still rates, so
    the anti-abuse rule can't be mistaken for 'only your first game ever
    counts'."""
    name, cookie = _fresh_cookie()

    first = _post(cookie, {"challenge_id": direct_challenge_id, "chain": [_A_ID, _B_ID]}).json()
    assert first["elo_delta"] != 0

    other = _post(cookie, {"challenge_id": second_challenge_id, "chain": [_A_ID, _Y_ID]}).json()
    assert other["valid"] is True
    assert other["elo_delta"] != 0, "a different challenge is a fresh ranked game"

    _, games = _profile_row(name)
    assert games == 2
