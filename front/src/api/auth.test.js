import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { checkAuth, initLogout } from "./auth.js";

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

describe("checkAuth — signed-in chrome", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="auth-hint"></div>
      <div id="auth-user"></div>
      <span id="auth-user-name"></span>
      <span id="auth-status-badge"></span>
    `;
  });

  it("swaps the sign-in hint for the user block once authenticated", async () => {
    mockMe(true);

    const data = await checkAuth();

    expect(data.authenticated).toBe(true);
    expect(document.getElementById("auth-hint").style.display).toBe("none");
    expect(document.getElementById("auth-user").style.display).toBe("flex");
    expect(document.getElementById("auth-status-badge").style.display).toBe("inline-flex");
  });

  it("shows the signed-in user's display name", async () => {
    mockMe(true);
    await checkAuth();
    expect(document.getElementById("auth-user-name").textContent).toBe("Test User");
  });

  it("falls back to a generic label when the account has no display name", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });

    await checkAuth();

    expect(document.getElementById("auth-user-name").textContent).toBe("Genius User");
  });

  it("keeps the sign-in hint visible for an anonymous visitor", async () => {
    mockMe(false);

    await checkAuth();

    expect(document.getElementById("auth-hint").style.display).toBe("flex");
    expect(document.getElementById("auth-user").style.display).toBe("none");
    expect(document.getElementById("auth-status-badge").style.display).toBe("none");
  });

  it("treats a failed /auth/me as simply not signed in", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));

    const data = await checkAuth();

    expect(data).toEqual({ authenticated: false });
    expect(document.getElementById("auth-hint").style.display).toBe("flex");
  });

  it("treats a non-OK /auth/me the same way, without reading the body", async () => {
    const json = vi.fn();
    apiFetch.mockResolvedValue({ ok: false, json });

    const data = await checkAuth();

    expect(data).toEqual({ authenticated: false });
    expect(json).not.toHaveBeenCalled();
  });

  it("works on a page that has none of the auth chrome", async () => {
    document.body.innerHTML = "";
    mockMe(true);

    await expect(checkAuth()).resolves.toMatchObject({ authenticated: true });
  });
});

describe("initLogout", () => {
  let assignedHref;

  beforeEach(() => {
    document.body.innerHTML = `<button id="auth-logout-btn"></button>`;
    document.cookie = "six_feat_csrf=csrf-token-123";
    assignedHref = null;
    delete window.location;
    window.location = {
      pathname: "/",
      search: "",
      set href(v) {
        assignedHref = v;
      },
      get href() {
        return assignedHref;
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing on a page with no logout button", () => {
    document.body.innerHTML = "";
    expect(() => initLogout()).not.toThrow();
  });

  it("posts to the logout endpoint with the CSRF token from the cookie", async () => {
    initLogout();
    document.getElementById("auth-logout-btn").click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe("/auth/logout");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-CSRF-Token"]).toBe("csrf-token-123");
  });

  it("sends an empty token rather than failing when the cookie is absent", async () => {
    document.cookie = "six_feat_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    initLogout();
    document.getElementById("auth-logout-btn").click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(fetch.mock.calls[0][1].headers["X-CSRF-Token"]).toBe("");
  });

  it("returns the user to the landing page after logging out", async () => {
    initLogout();
    document.getElementById("auth-logout-btn").click();

    await vi.waitFor(() => expect(assignedHref).toBe("/"));
  });

  it("still leaves the page even if the logout request fails", async () => {
    fetch.mockRejectedValue(new Error("offline"));
    initLogout();
    document.getElementById("auth-logout-btn").click();

    await vi.waitFor(() => expect(assignedHref).toBe("/"));
  });
});
