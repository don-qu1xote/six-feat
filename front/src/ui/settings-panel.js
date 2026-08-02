import { els } from "../dom/dom.js";
import { registerDockedPanel, closeOtherDockedPanels } from "./docked-panel.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "../state/helpers.js";
import { searchArtist } from "../api/api.js";
import {
  fetchSettingsStatus,
  connectGeniusToken,
  disconnectProvider,
  startYandexDeviceFlow,
  pollYandexDeviceFlow,
  fetchYandexPlaylists,
  fetchYandexImport,
} from "../api/settings-api.js";

let _panel = null;
let _yandexPollTimer = null;

export function isSettingsPanelOpen() {
  return !!els.settingsPanel?.classList.contains("show");
}

function _stopYandexPolling() {
  if (_yandexPollTimer) {
    clearTimeout(_yandexPollTimer);
    _yandexPollTimer = null;
  }
}

export function closeSettingsPanel() {
  els.settingsPanel?.classList.remove("show");
  _stopYandexPolling();
}

export function openSettingsPanel() {
  if (!els.settingsPanel) return;
  closeOtherDockedPanels(_panel);
  els.settingsPanel.classList.add("show");
  refreshSettingsStatus();
}

function _setGeniusConnected(connected) {
  if (els.settingsGeniusStatus) {
    els.settingsGeniusStatus.textContent = connected ? "Connected" : "Not connected";
  }
  if (els.settingsGeniusDisconnectBtn) els.settingsGeniusDisconnectBtn.hidden = !connected;
  if (els.settingsGeniusConnectBtn) {
    els.settingsGeniusConnectBtn.textContent = connected ? "Replace token" : "Connect";
  }
}

function _setYandexConnected(connected) {
  if (els.settingsYandexStatus) {
    els.settingsYandexStatus.textContent = connected ? "Connected" : "Not connected";
  }
  if (els.settingsYandexDisconnectBtn) els.settingsYandexDisconnectBtn.hidden = !connected;
  if (els.settingsYandexConnectBtn) els.settingsYandexConnectBtn.hidden = connected;
  if (connected && els.settingsYandexDeviceCode) {
    els.settingsYandexDeviceCode.hidden = true;
    els.settingsYandexDeviceCode.textContent = "";
  }

  if (els.settingsYandexImport) els.settingsYandexImport.hidden = !connected;
  if (!connected) {
    if (els.settingsYandexPlaylistList) {
      els.settingsYandexPlaylistList.hidden = true;
      els.settingsYandexPlaylistList.innerHTML = "";
    }
    if (els.settingsYandexArtistList) {
      els.settingsYandexArtistList.hidden = true;
      els.settingsYandexArtistList.innerHTML = "";
    }
  }
}

export async function refreshSettingsStatus() {
  const status = await fetchSettingsStatus();
  if (!status) return;
  _setGeniusConnected(!!status.genius?.connected);
  _setYandexConnected(!!status.yandex?.connected);
}

async function _handleGeniusConnect() {
  const token = els.settingsGeniusInput?.value?.trim();
  if (!token) {
    showToast("Paste a Genius token first.");
    return;
  }
  const result = await connectGeniusToken(token);
  if (!result.ok) {
    showToast("Couldn't connect that token — please try again.");
    return;
  }
  if (els.settingsGeniusInput) els.settingsGeniusInput.value = "";
  showToast("Genius token connected.");
  _setGeniusConnected(true);
}

async function _handleGeniusDisconnect() {
  const result = await disconnectProvider("genius");
  if (!result.ok && result.status !== 404) {
    showToast("Couldn't disconnect — please try again.");
    return;
  }
  showToast("Genius token disconnected.");
  _setGeniusConnected(false);
}

async function _pollYandexOnce(deviceCode, intervalMs) {
  const result = await pollYandexDeviceFlow(deviceCode);
  if (!isSettingsPanelOpen()) return;

  const status = result.data?.status;
  if (status === "connected") {
    showToast("Yandex account connected.");
    _setYandexConnected(true);
    return;
  }
  if (status === "denied") {
    showToast("Yandex sign-in was cancelled.");
    if (els.settingsYandexDeviceCode) els.settingsYandexDeviceCode.hidden = true;
    return;
  }
  if (status === "expired") {
    showToast("That code expired — try connecting again.");
    if (els.settingsYandexDeviceCode) els.settingsYandexDeviceCode.hidden = true;
    return;
  }

  _yandexPollTimer = setTimeout(() => _pollYandexOnce(deviceCode, intervalMs), intervalMs);
}

async function _handleYandexConnect() {
  const result = await startYandexDeviceFlow();
  if (!result.ok || !result.data?.device_code) {
    showToast("Couldn't reach Yandex — please try again.");
    return;
  }
  const {
    device_code: deviceCode,
    user_code: userCode,
    verification_url: url,
    interval,
  } = result.data;

  if (els.settingsYandexDeviceCode) {
    els.settingsYandexDeviceCode.hidden = false;
    els.settingsYandexDeviceCode.textContent = `Enter code ${userCode} at ${url}`;
  }

  _stopYandexPolling();
  const intervalMs = Math.max(1, interval || 5) * 1000;
  _yandexPollTimer = setTimeout(() => _pollYandexOnce(deviceCode, intervalMs), intervalMs);
}

async function _handleYandexDisconnect() {
  const result = await disconnectProvider("yandex");
  if (!result.ok && result.status !== 404) {
    showToast("Couldn't disconnect — please try again.");
    return;
  }
  showToast("Yandex account disconnected.");
  _setYandexConnected(false);
}

function _renderYandexPlaylists(playlists) {
  if (!els.settingsYandexPlaylistList) return;
  els.settingsYandexPlaylistList.innerHTML = (playlists || [])
    .map((p) => {
      const label =
        p.kind === "likes"
          ? "Liked tracks"
          : `${p.title || "Untitled playlist"} (${p.track_count ?? 0})`;
      return `<li><button type="button" class="ui-btn ui-btn--ghost" data-playlist-id="${escapeHtml(String(p.id))}">${escapeHtml(label)}</button></li>`;
    })
    .join("");
  els.settingsYandexPlaylistList.hidden = false;

  els.settingsYandexPlaylistList.querySelectorAll("button[data-playlist-id]").forEach((btn) => {
    btn.addEventListener("click", () => _handleYandexPlaylistPick(btn.dataset.playlistId));
  });
}

function _renderYandexImportResults(data) {
  if (!els.settingsYandexArtistList) return;
  const artists = data?.artists || [];
  els.settingsYandexArtistList.innerHTML = artists
    .map((a) => {
      if (!a.resolved) {
        return `<li class="settings-yandex-artist settings-yandex-artist--unresolved">${escapeHtml(a.yandex_name)} <span class="settings-card-sub">(not found on Genius)</span></li>`;
      }
      return `<li><button type="button" class="ui-btn ui-btn--ghost" data-artist-name="${escapeHtml(a.name)}">${escapeHtml(a.name)}</button></li>`;
    })
    .join("");
  els.settingsYandexArtistList.hidden = false;

  els.settingsYandexArtistList.querySelectorAll("button[data-artist-name]").forEach((btn) => {
    btn.addEventListener("click", () => _handleYandexArtistPick(btn.dataset.artistName));
  });
}

async function _handleYandexImportOpen() {
  const result = await fetchYandexPlaylists();
  if (!result) {
    showToast("Couldn't load your Yandex playlists — please try again.");
    return;
  }
  _renderYandexPlaylists(result.playlists);
  if (els.settingsYandexArtistList) {
    els.settingsYandexArtistList.hidden = true;
    els.settingsYandexArtistList.innerHTML = "";
  }
}

async function _handleYandexPlaylistPick(playlistId) {
  const result = await fetchYandexImport(playlistId);
  if (!result) {
    showToast("Couldn't import that source — please try again.");
    return;
  }
  _renderYandexImportResults(result);
}

function _handleYandexArtistPick(name) {
  if (!name) return;
  closeSettingsPanel();
  searchArtist(name, false, true);
}

export function setupSettingsPanel() {
  if (!els.settingsPanel) return;

  _panel = registerDockedPanel({
    el: els.settingsPanel,
    trigger: els.btnSettingsOpen,
    isOpen: isSettingsPanelOpen,
    close: closeSettingsPanel,
  });

  els.btnSettingsOpen?.addEventListener("click", () => {
    if (isSettingsPanelOpen()) closeSettingsPanel();
    else openSettingsPanel();
  });
  els.settingsPanelClose?.addEventListener("click", closeSettingsPanel);

  els.settingsGeniusConnectBtn?.addEventListener("click", _handleGeniusConnect);
  els.settingsGeniusDisconnectBtn?.addEventListener("click", _handleGeniusDisconnect);
  els.settingsYandexConnectBtn?.addEventListener("click", _handleYandexConnect);
  els.settingsYandexDisconnectBtn?.addEventListener("click", _handleYandexDisconnect);
  els.settingsYandexImportBtn?.addEventListener("click", _handleYandexImportOpen);
}
