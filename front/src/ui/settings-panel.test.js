import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./docked-panel.js", () => ({
  registerDockedPanel: vi.fn((panel) => panel),
  closeOtherDockedPanels: vi.fn(),
}));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));
vi.mock("../api/settings-api.js", () => ({
  fetchSettingsStatus: vi.fn(),
  connectGeniusToken: vi.fn(),
  disconnectProvider: vi.fn(),
  startYandexDeviceFlow: vi.fn(),
  pollYandexDeviceFlow: vi.fn(),
  setPreferredEnrichmentProvider: vi.fn(),
}));

import { els } from "../dom/dom.js";
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
  startYandexDeviceFlow,
  pollYandexDeviceFlow,
  setPreferredEnrichmentProvider,
} from "../api/settings-api.js";

function renderSettingsMarkup() {
  document.body.innerHTML = `
    <button id="btn-settings-open"></button>
    <div id="settings-panel">
      <button id="settings-panel-close"></button>

      <div class="settings-card">
        <div class="settings-card-title">
          Your Genius token <span class="settings-card-sub">(find more connections)</span>
        </div>
        <p class="settings-card-hint">
          Connecting your own Genius token also lets us use it to enrich the
          shared collaboration database in the background — not just your
          own graph.
        </p>
        <input id="settings-genius-input" type="password" />
        <button id="settings-genius-connect-btn"></button>
        <button id="settings-genius-disconnect-btn" hidden></button>
        <div id="settings-genius-status">Not connected</div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Background enrichment provider</div>
        <select id="settings-enrichment-provider-select">
          <option value="yandex">Yandex first</option>
          <option value="genius">Genius first</option>
        </select>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">
          Connect your Yandex <span class="settings-card-sub">(import playlists)</span>
        </div>
        <p class="settings-card-hint">
          Only used to suggest artists from your own playlists and likes —
          never affects the default graph or anyone else's.
        </p>
        <button id="settings-yandex-connect-btn"></button>
        <button id="settings-yandex-disconnect-btn" hidden></button>
        <div id="settings-yandex-device-code" hidden></div>
        <div id="settings-yandex-status">Not connected</div>
      </div>
    </div>
  `;

  els.btnSettingsOpen = document.getElementById("btn-settings-open");
  els.settingsPanel = document.getElementById("settings-panel");
  els.settingsPanelClose = document.getElementById("settings-panel-close");
  els.settingsGeniusInput = document.getElementById("settings-genius-input");
  els.settingsGeniusConnectBtn = document.getElementById("settings-genius-connect-btn");
  els.settingsGeniusDisconnectBtn = document.getElementById("settings-genius-disconnect-btn");
  els.settingsGeniusStatus = document.getElementById("settings-genius-status");
  els.settingsEnrichmentProviderSelect = document.getElementById(
    "settings-enrichment-provider-select",
  );
  els.settingsYandexConnectBtn = document.getElementById("settings-yandex-connect-btn");
  els.settingsYandexDisconnectBtn = document.getElementById("settings-yandex-disconnect-btn");
  els.settingsYandexStatus = document.getElementById("settings-yandex-status");
  els.settingsYandexDeviceCode = document.getElementById("settings-yandex-device-code");
}

beforeEach(() => {
  renderSettingsMarkup();
  fetchSettingsStatus.mockResolvedValue({
    genius: { connected: false },
    yandex: { connected: false },
  });
});

describe("[SF-YM-02] Settings panel renders both cards with the right explanations", () => {
  it("renders the Genius card's consent line before any token is pasted", () => {
    const hint =
      document.querySelector("#settings-genius-input").previousElementSibling.textContent;
    expect(hint).toMatch(/background/i);
    expect(hint).toMatch(/shared collaboration database/i);
  });

  it("renders the Genius card title mentioning 'find more connections'", () => {
    const title = document
      .getElementById("settings-genius-connect-btn")
      .closest(".settings-card")
      .querySelector(".settings-card-title").textContent;
    expect(title).toMatch(/Your Genius token/);
    expect(title).toMatch(/find more connections/i);
  });

  it("renders the Yandex card title mentioning 'import playlists'", () => {
    const title = document
      .getElementById("settings-yandex-connect-btn")
      .closest(".settings-card")
      .querySelector(".settings-card-title").textContent;
    expect(title).toMatch(/Connect your Yandex/);
    expect(title).toMatch(/import playlists/i);
  });

  it("the Yandex card's hint does NOT repeat the shared-enrichment consent copy", () => {
    const hint = document
      .getElementById("settings-yandex-connect-btn")
      .closest(".settings-card")
      .querySelector(".settings-card-hint").textContent;
    expect(hint).not.toMatch(/background/i);
    expect(hint).toMatch(/never affects/i);
  });

  it("the Genius and Yandex cards are separate elements, not one shared toggle", () => {
    const geniusCard = document
      .getElementById("settings-genius-connect-btn")
      .closest(".settings-card");
    const yandexCard = document
      .getElementById("settings-yandex-connect-btn")
      .closest(".settings-card");
    expect(geniusCard).not.toBeNull();
    expect(yandexCard).not.toBeNull();
    expect(geniusCard).not.toBe(yandexCard);
  });
});

describe("[SF-YM-07] background enrichment provider toggle", () => {
  beforeEach(() => {
    setupSettingsPanel();
  });

  it("defaults to yandex when the fetched status omits the preference", async () => {
    fetchSettingsStatus.mockResolvedValue({
      genius: { connected: false },
      yandex: { connected: false },
    });
    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsEnrichmentProviderSelect.value).toBe("yandex");
  });

  it("reflects a fetched genius preference on open", async () => {
    fetchSettingsStatus.mockResolvedValue({
      genius: { connected: true },
      yandex: { connected: false },
      preferred_enrichment_provider: "genius",
    });
    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsEnrichmentProviderSelect.value).toBe("genius");
  });

  it("persists the choice across a simulated reload (fetchSettingsStatus reflects the saved value)", async () => {
    fetchSettingsStatus.mockResolvedValue({
      genius: { connected: false },
      yandex: { connected: false },
      preferred_enrichment_provider: "yandex",
    });
    setPreferredEnrichmentProvider.mockResolvedValue({
      ok: true,
      status: 200,
      data: { preferred_enrichment_provider: "genius" },
    });

    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    els.settingsEnrichmentProviderSelect.value = "genius";
    els.settingsEnrichmentProviderSelect.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();

    expect(setPreferredEnrichmentProvider).toHaveBeenCalledWith("genius");

    fetchSettingsStatus.mockResolvedValue({
      genius: { connected: false },
      yandex: { connected: false },
      preferred_enrichment_provider: "genius",
    });
    openSettingsPanel();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.settingsEnrichmentProviderSelect.value).toBe("genius");
  });

  it("shows a toast confirming the choice on success", async () => {
    setPreferredEnrichmentProvider.mockResolvedValue({ ok: true, status: 200, data: {} });

    els.settingsEnrichmentProviderSelect.value = "genius";
    els.settingsEnrichmentProviderSelect.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/genius/i));
  });

  it("shows an error toast and does not crash when saving fails", async () => {
    setPreferredEnrichmentProvider.mockResolvedValue({ ok: false, status: 500, data: null });

    els.settingsEnrichmentProviderSelect.value = "genius";
    els.settingsEnrichmentProviderSelect.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't save/i));
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
      genius: { connected: true },
      yandex: { connected: false },
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

describe("[SF-YM-02] connecting a personal Yandex account (device flow)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupSettingsPanel();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the user code/verification url after starting the flow", async () => {
    startYandexDeviceFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        device_code: "dc-1",
        user_code: "AB12CD",
        verification_url: "https://oauth.yandex.ru/device",
        interval: 5,
        expires_in: 600,
      },
    });
    pollYandexDeviceFlow.mockResolvedValue({ ok: true, status: 200, data: { status: "pending" } });

    els.settingsYandexConnectBtn.click();
    await vi.runOnlyPendingTimersAsync();

    expect(els.settingsYandexDeviceCode.hidden).toBe(false);
    expect(els.settingsYandexDeviceCode.textContent).toMatch(/AB12CD/);
  });

  it("polls until status becomes connected, then updates the card", async () => {
    startYandexDeviceFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        device_code: "dc-2",
        user_code: "XY99ZZ",
        verification_url: "https://oauth.yandex.ru/device",
        interval: 1,
        expires_in: 600,
      },
    });
    pollYandexDeviceFlow
      .mockResolvedValueOnce({ ok: true, status: 200, data: { status: "pending" } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { status: "connected" } });

    openSettingsPanel();
    els.settingsYandexConnectBtn.click();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(pollYandexDeviceFlow).toHaveBeenCalledTimes(2);
    expect(els.settingsYandexStatus.textContent).toBe("Connected");
    expect(els.settingsYandexDisconnectBtn.hidden).toBe(false);
  });

  it("stops polling and shows a toast when the code is denied", async () => {
    startYandexDeviceFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        device_code: "dc-3",
        user_code: "DENY01",
        verification_url: "https://oauth.yandex.ru/device",
        interval: 1,
        expires_in: 600,
      },
    });
    pollYandexDeviceFlow.mockResolvedValue({ ok: true, status: 200, data: { status: "denied" } });

    openSettingsPanel();
    els.settingsYandexConnectBtn.click();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/cancelled/i));
    expect(els.settingsYandexStatus.textContent).toBe("Not connected");
  });

  it("stops polling once the panel is closed", async () => {
    startYandexDeviceFlow.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        device_code: "dc-4",
        user_code: "CLOSE1",
        verification_url: "https://oauth.yandex.ru/device",
        interval: 1,
        expires_in: 600,
      },
    });
    pollYandexDeviceFlow.mockResolvedValue({ ok: true, status: 200, data: { status: "pending" } });

    openSettingsPanel();
    els.settingsYandexConnectBtn.click();
    await vi.runOnlyPendingTimersAsync();
    expect(pollYandexDeviceFlow).toHaveBeenCalledTimes(1);

    closeSettingsPanel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pollYandexDeviceFlow).toHaveBeenCalledTimes(1);
  });
});
