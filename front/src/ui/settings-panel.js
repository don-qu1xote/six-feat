import { els } from "../dom/dom.js";
import { registerDockedPanel, closeOtherDockedPanels } from "./docked-panel.js";
import { showToast } from "./toast.js";
import {
  fetchSettingsStatus,
  connectGeniusToken,
  disconnectProvider,
  startYandexDeviceFlow,
  pollYandexDeviceFlow,
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
}
