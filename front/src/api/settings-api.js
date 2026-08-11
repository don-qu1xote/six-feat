import { apiFetch } from "./net.js";

async function getJsonWithStatus(url) {
  try {
    const res = await apiFetch(url);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch {
    return { status: null, data: null };
  }
}

async function postJson(url, body, method = "POST") {
  try {
    const res = await apiFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return { ok: false, status: null, data: null };
  }
}

export function fetchSettingsStatus() {
  return getJsonWithStatus("/api/v1/settings/providers");
}

export function connectGeniusToken(token) {
  return postJson("/api/v1/settings/genius-token", { token });
}

export function disconnectProvider(provider) {
  return postJson(`/api/v1/settings/disconnect?provider=${encodeURIComponent(provider)}`);
}

export function setEnrichmentEnabled(enabled) {
  return postJson("/api/v1/settings/enrichment-enabled", { enabled }, "PATCH");
}
