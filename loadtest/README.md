# loadtest/ — k6 load harness (SF-INF-05)

Three [k6](https://k6.io/) scenarios against the running six-feat API, plus
one against the game service (SF-GAME-20):

| Script                          | Exercises                          | "Temperature"                                                          |
|----------------------------------|-------------------------------------|-------------------------------------------------------------------------|
| `scenarios/graph_warm.js`        | `GET /api/v1/graph?artist=...`      | Warm — same seed artist every iteration, hits the ETag/DB-read fast path (SF-API-04) after the first request |
| `scenarios/path_cold.js`         | `GET /api/v1/graph/path?from=..&to=..` | Cold — path search has no persistent cache; random from/to pair each iteration |
| `scenarios/search.js`            | `GET /api/v1/search?q=...`          | Live — no cache at all, every call is a real Genius API round-trip     |
| `scenarios/game.js`              | search → `POST/GET /api/v1/game/challenge` → `GET /api/v1/game/leaderboard` → `GET /api/v1/game/profile` | Mixed — challenge create/get is cold (BFS on a new pair), leaderboard page 1 is [SF-PERF-06]-cached, profile is a plain indexed read |

All four ramp up/down (`lib/config.js`'s `stages`), check response status,
and enforce **advisory** p95-latency / error-rate thresholds — see
"Thresholds are advisory, not gates" below.

[SF-GAME-20 scoping note] `game.js` is runnable standalone (see its own
header) and via `run-all.sh GAME_SCENARIO=1` (below), but is deliberately
**not** part of `run-all.sh`'s default set or the blocking `load-test` CI
job — `scripts/e2e_env.py` only boots six-feat + genius-gateway today, not
six-feat-game, so running it there would just fail on connection-refused,
not measure anything real. Run it locally against a real `docker compose
up` stack (or extend `e2e_env.py` to also boot six-feat-game, at which
point folding it into the default set is the natural next step).

## Prerequisites

- [Install k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (or use the pinned binary the CI workflow downloads — see `.github/workflows/loadtest.yml`).
- A running six-feat stack, reachable at some `BASE_URL`.
- A valid `six_feat_session` cookie value for that stack (`SESSION_COOKIE`) — every scenario is authenticated, same as the API itself.

## Getting a session cookie

**Against `docker compose up` (real Genius OAuth):** log in through the
browser as usual (`http://localhost:8080` → "Sign in with Genius"), then
copy the `six_feat_session` cookie's value from your browser's dev tools
(Application/Storage → Cookies). Use `BASE_URL=http://localhost:8080`.

**Against a synthetic stack (no real Genius credentials needed):** this
repo already has one — `scripts/e2e_env.py`, the same harness the
`e2e-smoke` CI job (`.github/workflows/ci.yml`) uses. It builds and starts
`six_feat` + `six-feat-genius-gateway` against an in-process mock Genius
server, seeded with two artists (`Aurora Vale` / `Kessler Vane`) sharing
one song, and writes `base_url` + a pre-minted `session_cookie` to a JSON
file:

```bash
cmake -S services/six-feat -B build-six-feat -DCMAKE_BUILD_TYPE=Release && cmake --build build-six-feat -j"$(nproc)"
cmake -S services/genius-gateway -B build-genius-gateway -DCMAKE_BUILD_TYPE=Release && cmake --build build-genius-gateway -j"$(nproc)"

SIX_FEAT_BINARY=build-six-feat/six_feat \
SIX_FEAT_GENIUS_GATEWAY_BINARY=build-genius-gateway/six_feat_genius_gateway \
E2E_ENV_FILE=/tmp/six_feat_loadtest_env.json \
python3 scripts/e2e_env.py up &

# wait for /tmp/six_feat_loadtest_env.json to appear, then:
E2E_ENV_FILE=/tmp/six_feat_loadtest_env.json ./loadtest/run-all.sh
```

`run-all.sh` reads `base_url`/`session_cookie`/`seed_artist`/
`target_artist` straight out of `E2E_ENV_FILE` when the corresponding env
var isn't already set — see its header comment. Stop the synthetic stack
afterwards with `python3 scripts/e2e_env.py down`.

## Running

**Everything, against `docker compose` (or any stack) directly:**

```bash
BASE_URL=http://localhost:8080 \
SESSION_COOKIE=<cookie value> \
./loadtest/run-all.sh
```

**One scenario at a time:**

```bash
BASE_URL=http://localhost:8080 SESSION_COOKIE=<cookie> \
  k6 run loadtest/scenarios/graph_warm.js
```

**Against real (non-synthetic) Genius data**, widen `path_cold`'s and
`search`'s pools so they don't just repeat the same one or two queries:

```bash
BASE_URL=http://localhost:8080 SESSION_COOKIE=<cookie> \
FROM_ARTISTS="Drake,Kendrick Lamar,SZA" TO_ARTISTS="Travis Scott,J. Cole,Rihanna" \
SEARCH_QUERIES="Drake,Kendrick,SZA,Travis Scott" \
./loadtest/run-all.sh
```

## Env vars

| Var               | Default             | Used by                        |
|--------------------|----------------------|----------------------------------|
| `BASE_URL`          | `http://127.0.0.1:8080` | all                          |
| `SESSION_COOKIE`    | *(empty — required)* | all (authenticated requests)   |
| `PROFILE`           | `full`               | all — `full` (local ramp: 30s→10 VUs→2m→30s down) or `smoke` (CI: 5s→3 VUs→20s→5s down) |
| `SEED_ARTIST`       | `Aurora Vale`         | `graph_warm.js`                |
| `FROM_ARTIST` / `TO_ARTIST` | `Aurora Vale` / `Kessler Vane` | `path_cold.js` (fallback when the pools below are unset) |
| `FROM_ARTISTS` / `TO_ARTISTS` (comma-separated) | *(empty)* | `path_cold.js` — random pair per iteration |
| `SEARCH_QUERY` / `SEARCH_QUERIES` (comma-separated) | `Aurora Vale`, `Kessler Vane` | `search.js` — random pick per iteration. Against the synthetic mock stack these must be exact matches (its `/search` dispatch is exact-string, not fuzzy) — use the two seeded names, not a substring. |
| `E2E_ENV_FILE`      | *(unset)*             | `run-all.sh` only — see "Getting a session cookie" above |

## Output

Every scenario writes `loadtest/output/<scenario>-summary.{json,txt}`
(gitignored) via a shared `handleSummary()` (`lib/summary.js`) — the
`.txt` is a short human-readable digest (iteration count, avg/p95
duration, error rate, threshold pass/fail); the `.json` is k6's full
summary object. `run-all.sh` runs all three into the same directory.

## Thresholds: advisory in loadtest.yml, blocking in ci.yml's load-test job

Every scenario's `thresholds` block (p95 latency + error rate) reflects
expected behavior under this harness's own synthetic dataset — actual
numbers depend heavily on which Genius backend is behind `BASE_URL`: a
real Genius API round-trip has latency/rate-limit characteristics this
repo doesn't control, and the synthetic mock (`scripts/e2e_env.py`) is
deliberately minimal (two artists, one song), which caps how meaningfully
"cold" `path_cold`/`search` can actually be with the default pools.

`run-all.sh` itself always reports a threshold breach as a non-zero exit —
what happens with that exit code differs by caller (see "CI" below): the
nightly `loadtest.yml` job treats it as advisory (`continue-on-error:
true`), while `ci.yml`'s `load-test` job treats it as a hard gate (team
decision — see that job's own header comment in ci.yml for the accepted
flakiness tradeoff). If `ci.yml`'s load-test job turns out to be too flaky
in practice, the fix is flipping it to `continue-on-error: true`, not
changing `run-all.sh`'s own exit-code behavior.

## CI

Two separate CI consumers of this harness, deliberately not merged (see
`.github/workflows/ci.yml`'s "Pipeline shape" header comment):

- **`ci.yml`'s `load-test` job** (Stage 2) — runs on every push/PR,
  `PROFILE=smoke`, against the same synthetic `scripts/e2e_env.py` stack
  described above. **Blocking**: a threshold breach fails the job, and
  (via Stage 3's `needs:`) blocks `sbom`/`publish` on a push. This is the
  one PRs actually see.
- **`.github/workflows/loadtest.yml`'s `k6-smoke-load` job** — the same
  `PROFILE=smoke` pass against the same stack, but on `workflow_dispatch`
  and a nightly schedule only, `continue-on-error: true`. Exists
  independently of `ci.yml`'s load-test job for a longer-running,
  never-blocking check outside the PR path — useful if load-test above
  ever gets flipped to advisory, or just as a second nightly data point.

Both upload `loadtest/output/` as a build artifact regardless of outcome
(`k6-loadtest-ci-summary` from ci.yml, `k6-loadtest-summary` from
loadtest.yml) and publish the same summary to the job's step summary.
