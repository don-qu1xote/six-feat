// ════════════════════════════════════════════════════════════════════════════
// game/game-api.js — thin client for the six-feat-game service (services/game/*).
//
// Every function here maps 1:1 to one real endpoint the game service exposes
// (nginx proxies /api/v1/game/* → six-feat-game). None of them fake a
// response: on any non-2xx status or transport error they resolve to `null`
// (or, for checkLink, a { linked: null } "couldn't check" verdict), and the
// caller decides what that means for the UI — connect.js already treats a null
// as "the service couldn't do it, tell the player honestly" everywhere.
//
// Deliberately a SEPARATE module from ../api/api.js (the graph explorer's own
// client): that one owns the graph/search/enrichment surface and its State
// side effects; this one is pure request→JSON with no State coupling, so the
// game surface and its routed windows can import exactly what they need.
// Shares only the low-level apiFetch (../api/net.js) so a dropped connection
// is normalized the same way it is for the explorer.
// ════════════════════════════════════════════════════════════════════════════
import { apiFetch } from "../api/net.js";

// GET <url> → parsed JSON, or null on any non-ok status / transport error.
// Same-origin cookies (the six_feat_session the session-gated POSTs need) ride
// along on fetch's default credentials, exactly like the explorer's own calls.
async function getJson(url) {
  try {
    const res = await apiFetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// POST <url> with a JSON body → parsed JSON, or null on any failure. The game
// service reads JSON request bodies (challenge_handler/submit_handler), so the
// Content-Type is load-bearing, not decorative.
async function postJson(url, body) {
  try {
    const res = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Challenge lifecycle ───────────────────────────────────────────────────────

// POST /api/v1/game/challenge — create-or-get the challenge for a (from, to)
// pair. Idempotent by pair server-side (challenge_handler.cpp), so calling it
// again for the same endpoints returns the same row/id. role_mask 0 means "all
// roles" to the backend (it treats <= 0 as 15). Session required (POST) — a
// signed-out caller gets a 401 → null here.
export function createChallenge(fromId, toId, roleMask = 0) {
  return postJson("/api/v1/game/challenge", { from: fromId, to: toId, role_mask: roleMask });
}

// POST /api/v1/game/submit — score a finished chain against the challenge's
// own BFS ideal. `chain` is the ordered list of artist ids (start…goal).
// elapsed_ms is sent for completeness; scoring is server-authoritative.
export function submitChain(challengeId, chain, elapsedMs) {
  return postJson("/api/v1/game/submit", {
    challenge_id: challengeId,
    chain,
    elapsed_ms: elapsedMs,
  });
}

// GET /api/v1/game/challenge?daily=1 — the landing page's "Today's Challenge",
// with its endpoints already resolved to names/images. A 404 (no daily
// published yet in this environment) resolves to null, same as any other
// failure — the caller just leaves the composer as the only option.
export function fetchDailyChallenge() {
  return getJson("/api/v1/game/challenge?daily=1");
}

// GET /api/v1/game/challenge?id= — resume one challenge by id (no endpoint
// names, just the numeric shape). Used by deep-link/challenge-browser flows.
export function fetchChallenge(id) {
  return getJson(`/api/v1/game/challenge?id=${encodeURIComponent(id)}`);
}

// GET /api/v1/game/challenges — the challenge-browser listing (game-windows.js).
// `kind` filters daily/custom (empty = all); `cursor` is a previous page's
// next_cursor. → { challenges: [...], next_cursor: string|null } or null.
export function fetchChallenges({ kind = "", cursor = "", limit } = {}) {
  const p = new URLSearchParams();
  if (kind) p.set("kind", kind);
  if (cursor) p.set("cursor", cursor);
  if (limit) p.set("limit", String(limit));
  const qs = p.toString();
  return getJson(`/api/v1/game/challenges${qs ? `?${qs}` : ""}`);
}

// ── Leaderboards ──────────────────────────────────────────────────────────────

// GET /api/v1/game/leaderboard?challenge_id= — top-N for one challenge.
// → { entries: [{ user_id, display_name, score, hops, ts }], next_cursor } | null.
export function fetchLeaderboard(challengeId, { cursor = "", limit } = {}) {
  const p = new URLSearchParams({ challenge_id: String(challengeId) });
  if (cursor) p.set("cursor", cursor);
  if (limit) p.set("limit", String(limit));
  return getJson(`/api/v1/game/leaderboard?${p}`);
}

// Same endpoint, season-scoped — the season leaderboard tab / podium.
export function fetchSeasonLeaderboard(seasonId, { cursor = "", limit } = {}) {
  const p = new URLSearchParams({ season_id: String(seasonId) });
  if (cursor) p.set("cursor", cursor);
  if (limit) p.set("limit", String(limit));
  return getJson(`/api/v1/game/leaderboard?${p}`);
}

// ── Profile / season ──────────────────────────────────────────────────────────

// GET /api/v1/game/profile — the signed-in player's own profile (Elo, rank,
// games, achievements). A 401 (signed out) resolves to null; the Profile
// window shows its signed-out state instead.
export function fetchProfile() {
  return getJson("/api/v1/game/profile");
}

// GET /api/v1/game/profile?user= — another player's public profile, plus their
// recent attempt history. null on 404 (no such player) / failure.
export function fetchPublicProfile(userId) {
  return getJson(`/api/v1/game/profile?user=${encodeURIComponent(userId)}`);
}

// PATCH /api/v1/game/profile — rename the signed-in player. Returns the
// refreshed profile, or null on failure (e.g. a rejected/blocked name → the
// caller keeps the old one and tells the player). Uses PATCH via a small
// inline fetch since it's the only non-GET/POST verb the game client needs.
export async function updateDisplayName(name) {
  try {
    const res = await apiFetch("/api/v1/game/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: name }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// GET /api/v1/game/season — the Season & Achievements hub: current season,
// podium, and the achievement catalog, in one call. → season view or null.
export function fetchSeason() {
  return getJson("/api/v1/game/season");
}

// ── Admin (owner-gated) ───────────────────────────────────────────────────────

// GET /api/v1/game/admin — is the signed-in player an owner (on the
// GAME_ADMIN_GENIUS_IDS allowlist)? A UI-gating probe: a signed-out or
// non-owner caller is simply { admin: false }, never an error. → boolean.
export async function fetchAdminStatus() {
  const data = await getJson("/api/v1/game/admin");
  return !!(data && data.admin === true);
}

// POST /api/v1/game/admin — publish a daily challenge now. Pass a { from, to }
// id pair, or omit both (0 → the server picks a random pair). Owner-gated; a
// 403 (not an owner) / 422 (pair not connected in L1) resolves to null.
export function publishDaily({ from = 0, to = 0 } = {}) {
  const body = {};
  if (from) body.from = from;
  if (to) body.to = to;
  return postJson("/api/v1/game/admin", body);
}

// ── Live per-hop connection check ─────────────────────────────────────────────

// GET /api/v1/game/link?from=&to= — is `to` a real one-hop collaborator of
// `from`? The three-state verdict the branching web needs: { linked: true }
// (confirmed connected), { linked: false } (confirmed NOT connected), or
// { linked: null } (couldn't check — the caller fails OPEN, since the server
// still validates the whole winning line at submit). Anything but a boolean
// `linked` field — a failure, a JSON null, a malformed body — collapses to the
// null verdict.
export async function checkLink(fromId, toId) {
  const data = await getJson(
    `/api/v1/game/link?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`,
  );
  if (data && typeof data.linked === "boolean") return { linked: data.linked };
  return { linked: null };
}
