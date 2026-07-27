import { State } from "../state/state.js";
import { apiFetch } from "../api/net.js";

export function slice() {
  const s = State.connect;
  if (!s.photos) s.photos = {};
  if (!s.ids) s.ids = {};
  if (!s.unresolved) s.unresolved = {};
  return s;
}

export function setPhoto(name, url) {
  if (!name || !url) return;
  slice().photos[name] = url;
}

export function setId(name, id) {
  if (!name || id == null) return;
  slice().ids[name] = id;
}

export function idFor(name) {
  return slice().ids[name] ?? null;
}

export function isUnresolved(name) {
  return slice().unresolved[name] === true;
}

export function unresolvedNames() {
  return Object.keys(slice().unresolved);
}

export function clearUnresolved() {
  slice().unresolved = {};
}

export function photoFor(name) {
  return slice().photos[name] ?? null;
}

export function eqName(a, b) {
  return (
    String(a || "")
      .trim()
      .toLowerCase() ===
    String(b || "")
      .trim()
      .toLowerCase()
  );
}

export function endpointsReady() {
  const s = slice();
  return s.startName.trim().length > 0 && s.goalName.trim().length > 0;
}

export async function resolveId(name) {
  const cached = idFor(name);
  if (cached != null) return cached;
  const { top, definitive } = await searchTopCandidate(name);
  if (!top) {
    if (definitive) slice().unresolved[name] = true;
    return null;
  }
  setId(name, top.id);
  if (top.image) setPhoto(name, top.image);
  delete slice().unresolved[name];
  return top.id;
}

async function searchTopCandidate(name) {
  const q = String(name || "").trim();
  if (!q) return { top: null, definitive: true };
  try {
    const res = await apiFetch(`/api/v1/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return { top: null, definitive: false };
    const data = await res.json();
    const top = data?.candidates?.[0];
    return top && top.id != null ? { top, definitive: true } : { top: null, definitive: true };
  } catch {
    return { top: null, definitive: false };
  }
}

export async function resolveArtistId(name) {
  const { top } = await searchTopCandidate(name);
  return top ? top.id : null;
}

export function serializeGameShareState({ from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params;
}

export function parseGameShareState(search) {
  const params = new URLSearchParams(search || "");
  return { from: params.get("from") || null, to: params.get("to") || null };
}
