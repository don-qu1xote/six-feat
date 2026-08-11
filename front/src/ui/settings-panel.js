import { els } from "../dom/dom.js";
import { State } from "../state/state.js";
import { t, setLang } from "../i18n/i18n.js";
import { registerDockedPanel, closeOtherDockedPanels } from "./docked-panel.js";
import { showToast } from "./toast.js";
import { setTheme } from "./theme.js";
import {
  fetchSettingsStatus,
  connectGeniusToken,
  disconnectProvider,
  setEnrichmentEnabled,
} from "../api/settings-api.js";

let _panel = null;

export function isSettingsPanelOpen() {
  return !!els.settingsPanel?.classList.contains("show");
}

export function closeSettingsPanel() {
  els.settingsPanel?.classList.remove("show");
}

export function openSettingsPanel() {
  if (!els.settingsPanel) return;
  closeOtherDockedPanels(_panel);
  els.settingsPanel.classList.add("show");
  refreshSettingsStatus();
}

function _setGeniusConnected(connected) {
  if (els.settingsGeniusStatus) {
    els.settingsGeniusStatus.textContent = t(
      connected ? "settings.genius.connected" : "settings.genius.notConnected",
    );
    els.settingsGeniusStatus.classList.toggle("is-connected", connected);
  }
  if (els.settingsGeniusDisconnectBtn) els.settingsGeniusDisconnectBtn.hidden = !connected;
  if (els.settingsGeniusConnectBtn) {
    els.settingsGeniusConnectBtn.textContent = t(
      connected ? "settings.genius.replace" : "settings.genius.connect",
    );
  }
}

export async function refreshSettingsStatus() {
  if (els.settingsThemeSelect) els.settingsThemeSelect.value = State.theme || "dark";
  if (els.settingsLangSelect) els.settingsLangSelect.value = State.lang || "en";

  const { status, data } = await fetchSettingsStatus();

  const misconfigured = status === 503 && data?.error === "backend_misconfigured";
  const signedOut = status === 401 && !misconfigured;
  if (els.settingsSignedOutHint) els.settingsSignedOutHint.hidden = !signedOut;
  if (els.settingsMisconfiguredHint) els.settingsMisconfiguredHint.hidden = !misconfigured;
  if (els.settingsCards) els.settingsCards.hidden = signedOut || misconfigured;
  if (signedOut || misconfigured || !data) return;

  _setGeniusConnected(!!data.genius?.connected);
  if (els.settingsEnrichmentToggle) {
    els.settingsEnrichmentToggle.checked = data.enrichment_enabled !== false;
  }
}

function _handleThemeChange() {
  const theme = els.settingsThemeSelect?.value;
  if (theme !== "light" && theme !== "dark") return;
  setTheme(theme);
}

function _handleLangChange() {
  const lang = els.settingsLangSelect?.value;
  if (lang !== "en" && lang !== "ru") return;
  setLang(lang);
}

async function _handleEnrichmentToggleChange() {
  const enabled = !!els.settingsEnrichmentToggle?.checked;
  const result = await setEnrichmentEnabled(enabled);
  if (!result.ok) {
    showToast(t("settings.enrichment.saveError"));
    if (els.settingsEnrichmentToggle) els.settingsEnrichmentToggle.checked = !enabled;
  }
}

async function _handleGeniusConnect() {
  const token = els.settingsGeniusInput?.value?.trim();
  if (!token) {
    showToast(t("settings.genius.pasteFirst"));
    return;
  }
  const result = await connectGeniusToken(token);
  if (!result.ok) {
    showToast(t("settings.genius.connectError"));
    return;
  }
  if (els.settingsGeniusInput) els.settingsGeniusInput.value = "";
  showToast(t("settings.genius.connectedToast"));
  _setGeniusConnected(true, true);
}

async function _handleGeniusDisconnect() {
  const result = await disconnectProvider("genius");
  if (!result.ok && result.status !== 404) {
    showToast(t("settings.disconnectError"));
    return;
  }
  showToast(t("settings.genius.disconnectedToast"));
  _setGeniusConnected(false, true);
}

export function setupSettingsPanel() {
  if (!els.settingsPanel) return;

  _panel = registerDockedPanel({
    el: els.settingsBox,
    trigger: els.btnSettingsOpen,
    isOpen: isSettingsPanelOpen,
    close: closeSettingsPanel,
  });

  els.btnSettingsOpen?.addEventListener("click", () => {
    if (isSettingsPanelOpen()) closeSettingsPanel();
    else openSettingsPanel();
  });
  els.settingsPanelClose?.addEventListener("click", closeSettingsPanel);

  els.settingsThemeSelect?.addEventListener("change", _handleThemeChange);
  els.settingsLangSelect?.addEventListener("change", _handleLangChange);

  els.settingsGeniusConnectBtn?.addEventListener("click", _handleGeniusConnect);
  els.settingsGeniusDisconnectBtn?.addEventListener("click", _handleGeniusDisconnect);
  els.settingsEnrichmentToggle?.addEventListener("change", _handleEnrichmentToggleChange);
}
