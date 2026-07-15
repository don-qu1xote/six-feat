// loadtest/scenarios/search.js — SF-INF-05
//
// GET /api/v1/search: no persistent state at all (DEVELOPMENT.md,
// "Кэширование ответов") — every call is a live Genius API round-trip, so
// this scenario is the harness's most direct measure of upstream Genius
// latency/error-rate under load rather than six-feat's own DB/graph path.
//
// SEARCH_QUERIES (comma-separated) picks a random query per iteration —
// falls back to a single SEARCH_QUERY (default "Aurora", matching
// scripts/e2e_env.py's seeded artist) when unset.
//
// Run standalone:
//   BASE_URL=http://localhost:8080 SESSION_COOKIE=<cookie> \
//     SEARCH_QUERIES="Drake,Kendrick,SZA" k6 run loadtest/scenarios/search.js
// Or via loadtest/run-all.sh — see loadtest/README.md.

import http from "k6/http";
import { check, sleep } from "k6";
import { loadConfig, authParams, withQuery, pick } from "../lib/config.js";
import { summaryHandler } from "../lib/summary.js";

const cfg = loadConfig();

export const options = {
  scenarios: {
    search: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: cfg.stages,
    },
  },
  thresholds: {
    // Advisory only (SF-INF-05) — every call is a live Genius round-trip,
    // so this is the scenario most exposed to Genius-mock/API latency
    // variance outside six-feat's own control. See loadtest/README.md.
    http_req_duration: ["p(95)<1000"],
    http_req_failed: ["rate<0.02"],
  },
};

export default function () {
  const q = pick(cfg.searchQueries);
  const url = withQuery(`${cfg.baseUrl}/api/v1/search`, { q });

  const res = http.get(url, authParams(cfg.sessionCookie));

  check(res, {
    "status is 200": (r) => r.status === 200,
  });

  sleep(1);
}

export function handleSummary(data) {
  return summaryHandler("search", "loadtest/.output/search")(data);
}
