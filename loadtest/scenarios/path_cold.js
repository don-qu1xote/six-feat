// loadtest/scenarios/path_cold.js — SF-INF-05
//
// "Cold path" GET /api/v1/graph/path: unlike graph_warm.js, path search has
// no persistent cache of its own — every call walks the graph from
// scratch for whatever from/to pair it's given (see docs/DEVELOPMENT.md,
// "Кэширование ответов" — the path ETag is derived from both endpoints'
// live fetch_state, so it changes whenever either side's data does).
//
// FROM_ARTISTS/TO_ARTISTS (comma-separated) pick a random pair per
// iteration, so repeated VU iterations don't all just re-hit one pair —
// genuinely "cold" requires more than the one pair the synthetic
// scripts/e2e_env.py dataset provides; against a real docker-compose stack
// with real Genius data, pass a real pool of names.
//
// Run standalone:
//   BASE_URL=http://localhost:8080 SESSION_COOKIE=<cookie> \
//     FROM_ARTISTS="Aurora Vale,Kendrick Lamar" TO_ARTISTS="Kessler Vane,SZA" \
//     k6 run loadtest/scenarios/path_cold.js
// Or via loadtest/run-all.sh — see loadtest/README.md.

import http from "k6/http";
import { check, sleep } from "k6";
import { loadConfig, authParams, withQuery, pick } from "../lib/config.js";
import { summaryHandler } from "../lib/summary.js";

const cfg = loadConfig();
const fromPool = cfg.fromArtists.length ? cfg.fromArtists : [cfg.fromArtist];
const toPool = cfg.toArtists.length ? cfg.toArtists : [cfg.toArtist];

export const options = {
  scenarios: {
    path_cold: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: cfg.stages,
    },
  },
  thresholds: {
    // Advisory only (SF-INF-05) — a fresh graph traversal (plus resolving
    // both artist names against the Genius mock/API) is inherently slower
    // and more variable than graph_warm's repeat-hit path. See
    // loadtest/README.md.
    http_req_duration: ["p(95)<1500"],
    http_req_failed: ["rate<0.02"],
  },
};

export default function () {
  const from = pick(fromPool);
  const to = pick(toPool);
  const url = withQuery(`${cfg.baseUrl}/api/v1/graph/path`, { from, to });

  const res = http.get(url, authParams(cfg.sessionCookie));

  check(res, {
    // 200: path found, or {"error":"no_path"} — both valid outcomes.
    // 404: an artist name didn't resolve. 503: search deadline exceeded.
    // See tests/test_path.py for the full status-code contract.
    "status is 200, 404 or 503": (r) => [200, 404, 503].includes(r.status),
  });

  sleep(1);
}

export function handleSummary(data) {
  return summaryHandler("path cold", "loadtest/output/path_cold")(data);
}
