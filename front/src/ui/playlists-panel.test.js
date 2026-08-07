import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./toast.js", () => ({ showToast: vi.fn() }));
vi.mock("../api/settings-api.js", () => ({
  fetchSettingsStatus: vi.fn(),
  fetchYandexPlaylists: vi.fn(),
  fetchYandexImport: vi.fn(),
  startYandexDeviceFlow: vi.fn(),
  pollYandexDeviceFlow: vi.fn(),
}));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));

import { els } from "../dom/dom.js";
import { activatePlaylistsTab, setupPlaylistsPanel } from "./playlists-panel.js";
import { showToast } from "./toast.js";
import { searchArtist } from "../api/api.js";
import {
  fetchSettingsStatus,
  fetchYandexPlaylists,
  fetchYandexImport,
  startYandexDeviceFlow,
  pollYandexDeviceFlow,
} from "../api/settings-api.js";

function renderPlaylistsMarkup() {
  document.body.innerHTML = `
    <div id="hero-mode-panel-playlists">
      <p id="playlists-connect-hint" hidden></p>
      <div id="playlists-grant-hint" hidden>
        <button type="button" id="playlists-grant-btn"></button>
        <p id="playlists-device-code" hidden></p>
      </div>
      <div id="playlists-grid" hidden></div>
      <div id="playlists-artist-section" hidden>
        <p id="playlists-truncated-hint" hidden></p>
        <div id="playlists-artist-grid"></div>
      </div>
    </div>
  `;

  els.heroModePanelPlaylists = document.getElementById("hero-mode-panel-playlists");
  els.playlistsConnectHint = document.getElementById("playlists-connect-hint");
  els.playlistsGrantHint = document.getElementById("playlists-grant-hint");
  els.playlistsGrantBtn = document.getElementById("playlists-grant-btn");
  els.playlistsDeviceCode = document.getElementById("playlists-device-code");
  els.playlistsGrid = document.getElementById("playlists-grid");
  els.playlistsArtistSection = document.getElementById("playlists-artist-section");
  els.playlistsTruncatedHint = document.getElementById("playlists-truncated-hint");
  els.playlistsArtistGrid = document.getElementById("playlists-artist-grid");

  setupPlaylistsPanel();
}

beforeEach(() => {
  renderPlaylistsMarkup();
});

describe("[SF-WEB-74] Playlists tab — connection gating", () => {
  it("shows the connect hint and no grid when Yandex isn't connected", async () => {
    fetchSettingsStatus.mockResolvedValue({ status: 200, data: { yandex: { connected: false } } });

    await activatePlaylistsTab();

    expect(els.playlistsConnectHint.hidden).toBe(false);
    expect(els.playlistsGrid.hidden).toBe(true);
    expect(fetchYandexPlaylists).not.toHaveBeenCalled();
  });

  it("hides the connect hint and loads playlists once connected", async () => {
    fetchSettingsStatus.mockResolvedValue({ status: 200, data: { yandex: { connected: true } } });
    fetchYandexPlaylists.mockResolvedValue({
      status: 200,
      data: {
        type: "yandex_playlists",
        playlists: [{ id: "likes", kind: "likes", title: "Liked tracks", track_count: 0 }],
      },
    });

    await activatePlaylistsTab();

    expect(els.playlistsConnectHint.hidden).toBe(true);
    expect(fetchYandexPlaylists).toHaveBeenCalledTimes(1);
    expect(els.playlistsGrid.hidden).toBe(false);
  });
});

describe("[SF-WEB-74] Playlist cards render with covers", () => {
  beforeEach(() => {
    fetchSettingsStatus.mockResolvedValue({ status: 200, data: { yandex: { connected: true } } });
  });

  it("renders one card per playlist (plus likes), with a cover image", async () => {
    fetchYandexPlaylists.mockResolvedValue({
      status: 200,
      data: {
        playlists: [
          { id: "likes", kind: "likes", title: "Liked tracks", track_count: 5 },
          {
            id: "7",
            kind: "playlist",
            title: "Road Trip",
            track_count: 12,
            cover_url: "https://example.test/cover.jpg",
          },
        ],
      },
    });

    await activatePlaylistsTab();

    const cards = els.playlistsGrid.querySelectorAll(".playlist-card[data-playlist-id]");
    expect(cards).toHaveLength(2);
    expect([...cards].map((c) => c.dataset.playlistId)).toEqual(["likes", "7"]);

    const roadTripCard = els.playlistsGrid.querySelector('[data-playlist-id="7"]');
    const img = roadTripCard.querySelector(".playlist-card-cover");
    expect(img.getAttribute("src")).toBe("https://example.test/cover.jpg");
  });

  it("falls back to a placeholder image when a playlist has no cover_url", async () => {
    fetchYandexPlaylists.mockResolvedValue({
      status: 200,
      data: { playlists: [{ id: "9", kind: "playlist", title: "No Cover Here", track_count: 3 }] },
    });

    await activatePlaylistsTab();

    const card = els.playlistsGrid.querySelector('[data-playlist-id="9"]');
    const img = card.querySelector(".playlist-card-cover");
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  });

  it("shows a toast and no grid when the playlists fetch fails", async () => {
    fetchYandexPlaylists.mockResolvedValue({ status: null, data: null });

    await activatePlaylistsTab();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't load/i));
  });

  it("shows the grant-access prompt (not a toast) when the login token lacks Music API scope", async () => {
    fetchYandexPlaylists.mockResolvedValue({
      status: 502,
      data: { detail: "the connected Yandex token is no longer valid — reconnect it" },
    });

    await activatePlaylistsTab();

    expect(els.playlistsGrantHint.hidden).toBe(false);
    expect(els.playlistsGrid.hidden).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("shows the grant-access prompt (not a toast) when no Yandex account is connected (404)", async () => {
    fetchYandexPlaylists.mockResolvedValue({
      status: 404,
      data: { detail: "sign in with Yandex to use playlists" },
    });

    await activatePlaylistsTab();

    expect(els.playlistsGrantHint.hidden).toBe(false);
    expect(els.playlistsGrid.hidden).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("[SF-WEB-95] shows a distinct rejected-token toast (not the generic hint alone) on 403", async () => {
    fetchYandexPlaylists.mockResolvedValue({
      status: 403,
      data: {
        detail:
          "Yandex rejected the stored token — revoke access at id.yandex.ru/security and grant it again",
      },
    });

    await activatePlaylistsTab();

    expect(els.playlistsGrantHint.hidden).toBe(false);
    expect(els.playlistsGrid.hidden).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      "Yandex rejected the stored access — revoke it at id.yandex.ru/security, then grant access again.",
      8000,
    );
  });

  it("starts the device flow and shows the code when 'Grant playlist access' is clicked", async () => {
    fetchYandexPlaylists.mockResolvedValue({ status: 502, data: null });
    startYandexDeviceFlow.mockResolvedValue({
      ok: true,
      data: {
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_url: "https://ya.ru/device",
        interval: 5,
      },
    });
    pollYandexDeviceFlow.mockResolvedValue({ ok: true, data: { status: "pending" } });

    await activatePlaylistsTab();
    els.playlistsGrantBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.playlistsDeviceCode.hidden).toBe(false);
    expect(els.playlistsDeviceCode.textContent).toMatch(/ABCD-1234/);
    const link = els.playlistsDeviceCode.querySelector("a");
    expect(link.getAttribute("href")).toBe("https://ya.ru/device");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  it("copies the device code to the clipboard when the copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fetchYandexPlaylists.mockResolvedValue({ status: 502, data: null });
    startYandexDeviceFlow.mockResolvedValue({
      ok: true,
      data: {
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_url: "https://ya.ru/device",
        interval: 5,
      },
    });
    pollYandexDeviceFlow.mockResolvedValue({ ok: true, data: { status: "pending" } });

    await activatePlaylistsTab();
    els.playlistsGrantBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    els.playlistsDeviceCode.querySelector("button").click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
  });

  it("hides the prompt and reloads playlists once the device flow reports 'connected'", async () => {
    vi.useFakeTimers();
    fetchYandexPlaylists.mockResolvedValueOnce({ status: 502, data: null }).mockResolvedValueOnce({
      status: 200,
      data: {
        playlists: [{ id: "likes", kind: "likes", title: "Liked tracks", track_count: 0 }],
      },
    });
    startYandexDeviceFlow.mockResolvedValue({
      ok: true,
      data: {
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_url: "https://ya.ru/device",
        interval: 1,
      },
    });
    pollYandexDeviceFlow.mockResolvedValue({ ok: true, data: { status: "connected" } });

    await activatePlaylistsTab();
    els.playlistsGrantBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);

    expect(els.playlistsGrantHint.hidden).toBe(true);
    expect(fetchYandexPlaylists).toHaveBeenCalledTimes(2);
    expect(els.playlistsGrid.hidden).toBe(false);

    vi.useRealTimers();
  });
});

describe("[SF-WEB-74] Picking a playlist card shows artist cards", () => {
  beforeEach(() => {
    fetchSettingsStatus.mockResolvedValue({ status: 200, data: { yandex: { connected: true } } });
    fetchYandexPlaylists.mockResolvedValue({
      status: 200,
      data: { playlists: [{ id: "7", kind: "playlist", title: "Road Trip", track_count: 2 }] },
    });
  });

  it("renders resolved artists as clickable cards and unresolved ones as plain cards", async () => {
    fetchYandexImport.mockResolvedValue({
      type: "yandex_import",
      source: "playlist",
      playlist_id: "7",
      artists: [
        {
          yandex_name: "Resolvable Artist",
          resolved: true,
          id: 42,
          name: "Resolvable Artist",
          image: "https://example.test/artist.jpg",
        },
        { yandex_name: "Ghost Artist", resolved: false },
      ],
      resolved_count: 1,
      total_count: 2,
      truncated: false,
      total_track_count: 2,
      scanned_track_count: 2,
    });

    await activatePlaylistsTab();
    els.playlistsGrid.querySelector('[data-playlist-id="7"]').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchYandexImport).toHaveBeenCalledWith("7");
    expect(els.playlistsArtistSection.hidden).toBe(false);

    const resolvedCard = els.playlistsArtistGrid.querySelector(
      '[data-artist-name="Resolvable Artist"]',
    );
    expect(resolvedCard).not.toBeNull();
    expect(resolvedCard.querySelector(".playlist-card-cover").getAttribute("src")).toBe(
      "https://example.test/artist.jpg",
    );

    const unresolved = els.playlistsArtistGrid.querySelector(".playlist-card--unresolved");
    expect(unresolved).not.toBeNull();
    expect(unresolved.textContent).toMatch(/Ghost Artist/);
    expect(unresolved.textContent).toMatch(/not found/i);
    expect(unresolved.dataset.artistName).toBeUndefined();
  });

  it("clicking a resolved artist card calls searchArtist once", async () => {
    fetchYandexImport.mockResolvedValue({
      artists: [
        { yandex_name: "Resolvable Artist", resolved: true, id: 42, name: "Resolvable Artist" },
      ],
      resolved_count: 1,
      total_count: 1,
      truncated: false,
      total_track_count: 1,
      scanned_track_count: 1,
    });

    await activatePlaylistsTab();
    els.playlistsGrid.querySelector('[data-playlist-id="7"]').click();
    await Promise.resolve();
    await Promise.resolve();

    els.playlistsArtistGrid.querySelector("[data-artist-name]").click();

    expect(searchArtist).toHaveBeenCalledWith("Resolvable Artist", false, true);
    expect(searchArtist).toHaveBeenCalledTimes(1);
  });

  it("shows the truncated hint with the actual counts when the import was cut short", async () => {
    fetchYandexImport.mockResolvedValue({
      artists: [],
      resolved_count: 0,
      total_count: 0,
      truncated: true,
      total_track_count: 47,
      scanned_track_count: 20,
    });

    await activatePlaylistsTab();
    els.playlistsGrid.querySelector('[data-playlist-id="7"]').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.playlistsTruncatedHint.hidden).toBe(false);
    expect(els.playlistsTruncatedHint.textContent).toMatch(/first 20 of 47/i);
  });

  it("keeps the truncated hint hidden when the import wasn't cut short", async () => {
    fetchYandexImport.mockResolvedValue({
      artists: [],
      resolved_count: 0,
      total_count: 0,
      truncated: false,
      total_track_count: 2,
      scanned_track_count: 2,
    });

    await activatePlaylistsTab();
    els.playlistsGrid.querySelector('[data-playlist-id="7"]').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(els.playlistsTruncatedHint.hidden).toBe(true);
  });

  it("shows a toast and no results when the import fetch fails", async () => {
    fetchYandexImport.mockResolvedValue(null);

    await activatePlaylistsTab();
    els.playlistsGrid.querySelector('[data-playlist-id="7"]').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't import/i));
    expect(els.playlistsArtistSection.hidden).toBe(true);
  });
});
