// loadtest/scenarios/graph_warm.js — SF-INF-05
//
// "Warm cache" GET /api/v1/graph: every VU repeats the exact same
// ?artist=<SEED_ARTIST> query every iteration. The first hit per VU builds
// the graph (possibly a live Genius round-trip); every hit after that is
// served from an already-persisted fetch_state — a plain DB read, plus
// SF-API-04's ETag/If-None-Match fast path once a VU has seen a prior
// response's ETag (see lastEtag below). That's the "warm" contrast with
// path_cold.js's from/to traversal, which has no such repeat-hit cache.
//
// Run standalone:
//   BASE_URL=http://localhost:8080 SESSION_COOKIE=<cookie> \
//     k6 run loadtest/scenarios/graph_warm.js
// Or via loadtest/run-all.sh — see loadtest/README.md.

import http from "k6/http";
import { check, sleep } from "k6";
import { loadConfig, authParams, withQuery } from "../lib/config.js";
import { summaryHandler } from "../lib/summary.js";

const cfg = loadConfig();

export const options = {
  scenarios: {
    graph_warm: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: cfg.stages,
    },
  },
  thresholds: {
    // Advisory only (SF-INF-05) — actual latency depends on how "warm"
    // the backing Genius mock/API responses are, which this harness
    // doesn't control. See loadtest/README.md.
    http_req_duration: ["p(95)<300"],
    http_req_failed: ["rate<0.01"],
  },
};

// Module-scope state persists across iterations within the same VU (each
// VU gets its own JS runtime instance) — exactly the per-VU "remembers the
// last ETag" behavior a real repeat-visit browser session would have.
let lastEtag = null;

export default function () {
  const url = withQuery(`${cfg.baseUrl}/api/v1/graph`, { artist: cfg.seedArtist });
  const params = authParams(cfg.sessionCookie);
  if (lastEtag) {
    params.headers["If-None-Match"] = lastEtag;
  }

  const res = http.get(url, params);

  // Go's http canonicalizes the response header name to "Etag".
  if (res.status === 200 && res.headers["Etag"]) {
    lastEtag = res.headers["Etag"];
  }

  check(res, {
    "status is 200 or 304": (r) => r.status === 200 || r.status === 304,
    "200 body has seed_id": (r) =>
      r.status !== 200 || JSON.parse(r.body).seed_id !== undefined,
  });

  sleep(1);
}

export function handleSummary(data) {
  return summaryHandler("graph warm-cache", "loadtest/.output/graph_warm")(data);
}
