import { apiFetch } from "../api/net.js";

async function getJson(url) {
  try {
    const res = await apiFetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

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

export function createChallenge(fromId, toId, roleMask = 0) {
  return postJson("/api/v1/game/challenge", { from: fromId, to: toId, role_mask: roleMask });
}

export function submitChain(challengeId, chain, elapsedMs) {
  return postJson("/api/v1/game/submit", {
    challenge_id: challengeId,
    chain,
    elapsed_ms: elapsedMs,
  });
}

export function fetchDailyChallenge() {
  return getJson("/api/v1/game/challenge?daily=1");
}

export async function fetchDailyChallengeState() {
  try {
    const res = await apiFetch("/api/v1/game/challenge?daily=1");
    if (res.status === 404) return { status: "none", daily: null };
    if (!res.ok) return { status: "unavailable", daily: null };
    return { status: "ok", daily: await res.json() };
  } catch {
    return { status: "unavailable", daily: null };
  }
}

export function fetchChallenge(id) {
  return getJson(`/api/v1/game/challenge?id=${encodeURIComponent(id)}`);
}

export function fetchChallenges({ kind = "", query = "", cursor = "", limit } = {}) {
  const p = new URLSearchParams();
  if (kind) p.set("kind", kind);
  if (query) p.set("q", query);
  if (cursor) p.set("cursor", cursor);
  if (limit) p.set("limit", String(limit));
  const qs = p.toString();
  return getJson(`/api/v1/game/challenges${qs ? `?${qs}` : ""}`);
}

export function fetchLeaderboard(challengeId, { cursor = "", limit } = {}) {
  const p = new URLSearchParams({ challenge_id: String(challengeId) });
  if (cursor) p.set("cursor", cursor);
  if (limit) p.set("limit", String(limit));
  return getJson(`/api/v1/game/leaderboard?${p}`);
}

export function fetchSeasonLeaderboard(seasonId, { cursor = "", limit } = {}) {
  const p = new URLSearchParams({ season_id: String(seasonId) });
  if (cursor) p.set("cursor", cursor);
  if (limit) p.set("limit", String(limit));
  return getJson(`/api/v1/game/leaderboard?${p}`);
}

export function fetchProfile() {
  return getJson("/api/v1/game/profile");
}

export function fetchPublicProfile(userId) {
  return getJson(`/api/v1/game/profile?user=${encodeURIComponent(userId)}`);
}

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

export function fetchSeason() {
  return getJson("/api/v1/game/season");
}

export async function fetchAdminStatus() {
  const data = await getJson("/api/v1/game/admin");
  return !!(data && data.admin === true);
}

export function publishDaily({ from = 0, to = 0 } = {}) {
  const body = {};
  if (from) body.from = from;
  if (to) body.to = to;
  return postJson("/api/v1/game/admin", body);
}

export async function checkLink(fromId, toId) {
  const data = await getJson(
    `/api/v1/game/link?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`,
  );
  if (data && typeof data.linked === "boolean") return { linked: data.linked };
  return { linked: null };
}
