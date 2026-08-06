import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ui/index.js", () => ({ showToast: vi.fn() }));
vi.mock("../ui/settings-panel.js", () => ({
  openSettingsPanel: vi.fn(),
  refreshSettingsStatus: vi.fn(),
}));
vi.mock("./net.js", () => ({ apiFetch: vi.fn() }));

import { showToast } from "../ui/index.js";
import { openSettingsPanel, refreshSettingsStatus } from "../ui/settings-panel.js";
import { State } from "../state/state.js";
import { apiFetch } from "./net.js";
import { checkAuth } from "./auth.js";

function mockMe(authenticated) {
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () =>
      authenticated ? { authenticated: true, name: "Test User" } : { authenticated: false },
  });
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="auth-hint"></div>
    <div id="auth-user"></div>
    <span id="auth-user-name"></span>
  `;
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks();
  mockMe(false);
  State.lang = "en";
});

describe("[SF-WEB-77] genius_link redirect param (account-link flow, not session login)", () => {
  it("shows a success toast and refreshes/opens Settings on ?genius_link=connected", async () => {
    window.history.pushState({}, "", "/?genius_link=connected");

    await checkAuth();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/genius account connected/i));
    expect(openSettingsPanel).toHaveBeenCalled();
    expect(refreshSettingsStatus).toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("shows a cancelled toast on ?genius_link=denied, without touching Settings", async () => {
    window.history.pushState({}, "", "/?genius_link=denied");

    await checkAuth();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/cancelled/i));
    expect(openSettingsPanel).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("shows an error toast on ?genius_link=error", async () => {
    window.history.pushState({}, "", "/?genius_link=error");

    await checkAuth();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't connect/i));
    expect(openSettingsPanel).not.toHaveBeenCalled();
  });

  it("leaves an ordinary ?auth= redirect's handling untouched", async () => {
    window.history.pushState({}, "", "/?auth=denied");

    await checkAuth();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/sign-in was cancelled/i));
    expect(openSettingsPanel).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("does nothing when there's no redirect param at all", async () => {
    await checkAuth();

    expect(showToast).not.toHaveBeenCalled();
    expect(openSettingsPanel).not.toHaveBeenCalled();
    expect(refreshSettingsStatus).not.toHaveBeenCalled();
  });
});
