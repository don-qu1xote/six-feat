


















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
  return summaryHandler("search", "loadtest/output/search")(data);
}
