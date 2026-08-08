import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./docked-panel.js", () => ({
  registerDockedPanel: vi.fn((panel) => panel),
  closeOtherDockedPanels: vi.fn(),
}));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));
vi.mock("../api/settings-api.js", () => ({
  fetchSettingsStatus: vi.fn(),
  connectGeniusToken: vi.fn(),
  disconnectProvider: vi.fn(),
  setEnrichmentEnabled: vi.fn(),
}));

import { els } from "../dom/dom.js";
import { State } from "../state/state.js";
import {
  setupSettingsPanel,
  openSettingsPanel,
  closeSettingsPanel,
  isSettingsPanelOpen,
} from "./settings-panel.js";
import { showToast } from "./toast.js";
import {
  fetchSettingsStatus,
  connectGeniusToken,
  disconnectProvider,
  setEnrichmentEnabled,
} from "../api/settings-api.js";

function renderSettingsMarkup() {
  document.body.innerHTML = `
    <button id="btn-settings-open"></button>
    <div id="settings-panel">
      <button id="settings-panel-close"></button>

      <select id="settings-theme-select">
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
      <select id="settings-lang-select">
        <option value="en">English</option>
        <option value="ru">Русский</option>
      </select>

      <p id="settings-signed-out-hint" hidden>Sign in to manage settings.</p>
      <p id="settings-misconfigured-hint" hidden>Settings can't verify your sign-in right now.</p>

      <div id="settings-cards">
      <div class="settings-card">
        <div class="settings-card-title">
          Genius <span class="settings-card-sub">(find more connections)</span>
        </div>
        <p class="settings-card-hint">Optional — you're already signed in with Genius; connect a different token here only if you want deepen to use one with different scopes/quota.</p>
        <button id="settings-genius-disconnect-btn" hidden></button>
        <div id="settings-genius-status">Not connected</div>
        <input id="settings-genius-input" type="password" />
        <button id="settings-genius-connect-btn"></button>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Background enrichment</div>
        <input type="checkbox" id="settings-enrichment-toggle" checked />
      </div>
      </div>
    </div>
  `;

  els.btnSettingsOpen = document.getElementById("btn-settings-open");
  els.settingsPanel = document.getElementById("settings-panel");
  els.settingsPanelClose = document.getElementById("settings-panel-close");
  els.settingsThemeSelect = document.getElementById("settings-theme-select");
  els.settingsLangSelect = document.getElementById("settings-lang-select");
  els.settingsSignedOutHint = document.getElementById("settings-signed-out-hint");
  els.settingsMisconfiguredHint = document.getElementById("settings-misconfigured-hint");
  els.settingsCards = document.getElementById("settings-cards");
  els.settingsGeniusInput = document.getElementById("settings-genius-input");
  els.settingsGeniusConnectBtn = document.getElementById("settings-genius-connect-btn");
  els.settingsGeniusDisconnectBtn = document.getElementById("settings-genius-disconnect-btn");
  els.settingsGeniusStatus = document.getElementById("settings-genius-status");
  els.settingsEnrichmentToggle = document.getElementById("settings-enrichment-toggle");
}

beforeEach(() => {
  renderSettingsMarkup();
  State.lang = "en";
  fetchSettingsStatus.mockResolvedValue({
    status: 200,
    data: {
      genius: { connected: false },
    },
  });
});

describe("[SF-YM-02] Settings panel renders the Genius card with the right explanation", () => {
  it("renders the Genius card title mentioning 'find more connections'", () => {
    const title = document
      .getElementById("settings-genius-connect-btn")
      .closest(".settings-card")
      .querySelector(".settings-card-title").textContent;
    expect(title).toMatch(/Genius/);
    expect(title).toMatch(/find more connections/i);
  });

  it("the Genius card's hint frames the manual-token field as optional, not required", () => {
    const hint = document
      .getElementById("settings-genius-connect-btn")
      .closest(".settings-card")
      .querySelector(".settings-card-hint").textContent;
    expect(hint).toMatch(/optional/i);
  });
});

describe("[SF-WEB-81] background enrichment on/off toggle", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("defaults to checked when the fetched status omits the flag", async () => {
    fetchSettingsStatus.mockResolvedValue({
      status: 200,
      data: {
        genius: { connected: false },
      },
    });
    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsEnrichmentToggle.checked).toBe(true);
  });

  it("reflects a fetched enrichment_enabled: false on open", async () => {
    fetchSettingsStatus.mockResolvedValue({
      status: 200,
      data: {
        genius: { connected: false },
        enrichment_enabled: false,
      },
    });
    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsEnrichmentToggle.checked).toBe(false);
  });

  it("saves the new state when toggled", async () => {
    setEnrichmentEnabled.mockResolvedValue({ ok: true, status: 200, data: {} });

    els.settingsEnrichmentToggle.checked = false;
    els.settingsEnrichmentToggle.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();

    expect(setEnrichmentEnabled).toHaveBeenCalledWith(false);
  });

  it("reverts the toggle and shows an error toast when saving fails", async () => {
    setEnrichmentEnabled.mockResolvedValue({ ok: false, status: 500, data: null });

    els.settingsEnrichmentToggle.checked = false;
    els.settingsEnrichmentToggle.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't save/i));
    expect(els.settingsEnrichmentToggle.checked).toBe(true);
  });
});

describe("[SF-YM-02] opening the panel refreshes connection status", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("openSettingsPanel adds the show class and fetches status", async () => {
    openSettingsPanel();
    expect(els.settingsPanel.classList.contains("show")).toBe(true);
    expect(fetchSettingsStatus).toHaveBeenCalled();
  });

  it("closeSettingsPanel removes the show class", () => {
    openSettingsPanel();
    closeSettingsPanel();
    expect(isSettingsPanelOpen()).toBe(false);
  });

  it("reflects a connected Genius token in the status text", async () => {
    fetchSettingsStatus.mockResolvedValue({
      status: 200,
      data: {
        genius: { connected: true },
      },
    });
    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();
    expect(els.settingsGeniusStatus.textContent).toBe("Connected");
    expect(els.settingsGeniusDisconnectBtn.hidden).toBe(false);
  });
});

describe("[SF-YM-02] connecting a Genius token", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("shows a toast and does nothing when the input is empty", async () => {
    els.settingsGeniusInput.value = "  ";
    els.settingsGeniusConnectBtn.click();
    await Promise.resolve();
    expect(connectGeniusToken).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/paste/i));
  });

  it("connects the pasted token and clears the input on success", async () => {
    connectGeniusToken.mockResolvedValue({ ok: true, status: 200, data: {} });
    els.settingsGeniusInput.value = "sf-genius-token-123";
    els.settingsGeniusConnectBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(connectGeniusToken).toHaveBeenCalledWith("sf-genius-token-123");
    expect(els.settingsGeniusInput.value).toBe("");
    expect(els.settingsGeniusStatus.textContent).toBe("Connected");
  });

  it("shows an error toast and keeps the input on failure", async () => {
    connectGeniusToken.mockResolvedValue({ ok: false, status: 400, data: null });
    els.settingsGeniusInput.value = "bad-token";
    els.settingsGeniusConnectBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsGeniusInput.value).toBe("bad-token");
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't connect/i));
  });

  it("disconnecting clears the connected state", async () => {
    disconnectProvider.mockResolvedValue({ ok: true, status: 200, data: {} });
    els.settingsGeniusDisconnectBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(disconnectProvider).toHaveBeenCalledWith("genius");
    expect(els.settingsGeniusStatus.textContent).toBe("Not connected");
  });
});

describe("[SF-WEB-75] anonymous visitor sees an explicit sign-in call to action", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("shows 'Sign in to manage settings' and hides the cards on a 401, instead of a silent empty state", async () => {
    fetchSettingsStatus.mockResolvedValue({ status: 401, data: null });

    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsSignedOutHint.hidden).toBe(false);
    expect(els.settingsSignedOutHint.textContent).toMatch(/sign in to manage settings/i);
    expect(els.settingsCards.hidden).toBe(true);
  });

  it("hides the sign-in hint and shows the cards once a real status comes back", async () => {
    fetchSettingsStatus.mockResolvedValue({
      status: 200,
      data: { genius: { connected: false } },
    });

    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsSignedOutHint.hidden).toBe(true);
    expect(els.settingsCards.hidden).toBe(false);
  });
});

describe("[SF-WEB-77] backend-misconfigured (APP_SECRET mismatch) is distinguished from a real 401", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("shows the misconfigured hint (not the sign-in hint) on a 503 backend_misconfigured", async () => {
    fetchSettingsStatus.mockResolvedValue({
      status: 503,
      data: { error: "backend_misconfigured" },
    });

    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsMisconfiguredHint.hidden).toBe(false);
    expect(els.settingsSignedOutHint.hidden).toBe(true);
    expect(els.settingsCards.hidden).toBe(true);
  });

  it("still treats an ordinary 401 as a sign-in prompt, not a misconfiguration", async () => {
    fetchSettingsStatus.mockResolvedValue({ status: 401, data: null });

    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsSignedOutHint.hidden).toBe(false);
    expect(els.settingsMisconfiguredHint.hidden).toBe(true);
  });
});

describe("[SF-WEB-77] Appearance card replaces the old floating theme-toggle button", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("reflects the current theme when the panel opens, even signed out", async () => {
    State.theme = "light";
    fetchSettingsStatus.mockResolvedValue({ status: 401, data: null });

    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsThemeSelect.value).toBe("light");
  });

  it("applies the chosen theme to the document immediately on change", () => {
    els.settingsThemeSelect.value = "light";
    els.settingsThemeSelect.dispatchEvent(new Event("change"));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(State.theme).toBe("light");
  });

  it("persists the choice so a reload sees it (localStorage), unlike the old system-only toggle", () => {
    els.settingsThemeSelect.value = "light";
    els.settingsThemeSelect.dispatchEvent(new Event("change"));

    expect(localStorage.getItem("six-feat-theme")).toBe("light");
  });
});

describe("[SF-WEB-77] Language card (i18n) in Settings", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("reflects the current language when the panel opens, even signed out", async () => {
    State.lang = "ru";
    fetchSettingsStatus.mockResolvedValue({ status: 401, data: null });

    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsLangSelect.value).toBe("ru");
  });

  it("re-renders every [data-i18n] node and persists the choice on change", () => {
    document.body.innerHTML += `<span id="probe" data-i18n="settings.title"></span>`;

    els.settingsLangSelect.value = "ru";
    els.settingsLangSelect.dispatchEvent(new Event("change"));

    expect(document.getElementById("probe").textContent).toBe("Настройки");
    expect(document.documentElement.getAttribute("lang")).toBe("ru");
    expect(localStorage.getItem("six-feat-lang")).toBe("ru");
    expect(State.lang).toBe("ru");
  });
});
