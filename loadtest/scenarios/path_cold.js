



















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
