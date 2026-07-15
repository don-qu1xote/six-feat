// loadtest/lib/config.js — SF-INF-05
//
// Shared env-var parsing for all loadtest/scenarios/*.js scripts. Every
// scenario is runnable standalone (`k6 run loadtest/scenarios/search.js`)
// with these same env vars — loadtest/run-all.sh (used by the README's
// "run everything" path and the k6-smoke-load CI workflow) just sets them
// once for all three. See loadtest/README.md for the full list.
//
// No URLSearchParams here on purpose — it isn't a k6/goja builtin across
// all supported versions, so query strings are hand-built (withQuery
// below) instead of relying on it.

export function loadConfig() {
  const profile = (__ENV.PROFILE || "full").toLowerCase();
  const isSmoke = profile === "smoke";

  return {
    baseUrl: (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, ""),
    // Raw `six_feat_session` cookie value — see README.md for how to get
    // one, either from a real browser OAuth login (docker-compose) or
    // scripts/e2e_env.py's env-file (CI / synthetic local runs).
    sessionCookie: __ENV.SESSION_COOKIE || "",
    seedArtist: __ENV.SEED_ARTIST || "Aurora Vale",
    fromArtist: __ENV.FROM_ARTIST || "Aurora Vale",
    toArtist: __ENV.TO_ARTIST || "Kessler Vane",
    // Comma-separated pools let a run against a real (non-synthetic) stack
    // exercise more than one from/to pair per iteration, for a genuinely
    // "cold" (not repeatedly-hitting-the-same-pair) path scenario — falls
    // back to the single from/to pair above when unset, which is all the
    // synthetic two-artist scripts/e2e_env.py dataset can offer.
    fromArtists: splitList(__ENV.FROM_ARTISTS),
    toArtists: splitList(__ENV.TO_ARTISTS),
    searchQueries: splitList(__ENV.SEARCH_QUERIES || __ENV.SEARCH_QUERY) || ["Aurora"],
    isSmoke,
    // Smoke: short enough for a nightly/on-demand CI job against the
    // synthetic mock-Genius stack (scripts/e2e_env.py). Full: a real local
    // ramp-up profile for `docker compose` runs — see README.md.
    stages: isSmoke
      ? [
          { duration: "5s", target: 3 },
          { duration: "20s", target: 3 },
          { duration: "5s", target: 0 },
        ]
      : [
          { duration: "30s", target: 10 },
          { duration: "2m", target: 10 },
          { duration: "30s", target: 0 },
        ],
  };
}

function splitList(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function authParams(cookie) {
  return {
    headers: cookie ? { Cookie: `six_feat_session=${cookie}` } : {},
  };
}

export function withQuery(url, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? `${url}?${qs}` : url;
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
