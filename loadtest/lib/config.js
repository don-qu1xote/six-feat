











export function loadConfig() {
  const profile = (__ENV.PROFILE || "full").toLowerCase();
  const isSmoke = profile === "smoke";

  return {
    baseUrl: (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, ""),



    sessionCookie: __ENV.SESSION_COOKIE || "",
    seedArtist: __ENV.SEED_ARTIST || "Aurora Vale",
    fromArtist: __ENV.FROM_ARTIST || "Aurora Vale",
    toArtist: __ENV.TO_ARTIST || "Kessler Vane",





    fromArtists: splitList(__ENV.FROM_ARTISTS),
    toArtists: splitList(__ENV.TO_ARTISTS),



















    searchQueries: (() => {
      const parsed = splitList(__ENV.SEARCH_QUERIES || __ENV.SEARCH_QUERY);
      return parsed.length ? parsed : ["Aurora Vale", "Kessler Vane"];
    })(),
    isSmoke,



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
