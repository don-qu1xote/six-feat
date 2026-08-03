import { apiFetch } from "./net.js";

async function getJson(url) {
  try {
    const res = await apiFetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
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
  return getJson("/api/v1/settings/providers");
}

export function connectGeniusToken(token) {
  return postJson("/api/v1/settings/genius-token", { token });
}

export function disconnectProvider(provider) {
  return postJson(`/api/v1/settings/disconnect?provider=${encodeURIComponent(provider)}`);
}

export function startYandexDeviceFlow() {
  return postJson("/api/v1/settings/yandex/device/start");
}

export function pollYandexDeviceFlow(deviceCode) {
  return postJson("/api/v1/settings/yandex/device/poll", { device_code: deviceCode });
}

export function fetchYandexPlaylists() {
  return getJson("/api/v1/settings/yandex/playlists");
}

export function fetchYandexImport(playlistId) {
  return getJson(`/api/v1/settings/yandex/import?playlist=${encodeURIComponent(playlistId)}`);
}

// [SF-YM-07] provider: "yandex" | "genius" — order of attempts for this
// user's own background enrichment jobs, not the service-wide default chain.
export function setPreferredEnrichmentProvider(provider) {
  return postJson("/api/v1/settings/enrichment-provider", { provider }, "PATCH");
}
