














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



    http_req_duration: ["p(95)<300"],
    http_req_failed: ["rate<0.01"],
  },
};




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
  return summaryHandler("graph warm-cache", "loadtest/output/graph_warm")(data);
}
