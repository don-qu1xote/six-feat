import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./toast.js", () => ({ showToast: vi.fn() }));
vi.mock("../api/settings-api.js", () => ({
  fetchSettingsStatus: vi.fn(),
  fetchYandexPlaylists: vi.fn(),
  fetchYandexImport: vi.fn(),
}));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));

import { els } from "../dom/dom.js";
import { activatePlaylistsTab } from "./playlists-panel.js";
import { showToast } from "./toast.js";
import { searchArtist } from "../api/api.js";
import {
  fetchSettingsStatus,
  fetchYandexPlaylists,
  fetchYandexImport,
} from "../api/settings-api.js";

function renderPlaylistsMarkup() {
  document.body.innerHTML = `
    <div id="hero-mode-panel-playlists">
      <p id="playlists-connect-hint" hidden></p>
      <div id="playlists-grid" hidden></div>
      <div id="playlists-artist-section" hidden>
        <p id="playlists-truncated-hint" hidden></p>
        <div id="playlists-artist-grid"></div>
      </div>
    </div>
  `;

  els.heroModePanelPlaylists = document.getElementById("hero-mode-panel-playlists");
  els.playlistsConnectHint = document.getElementById("playlists-connect-hint");
  els.playlistsGrid = document.getElementById("playlists-grid");
  els.playlistsArtistSection = document.getElementById("playlists-artist-section");
  els.playlistsTruncatedHint = document.getElementById("playlists-truncated-hint");
  els.playlistsArtistGrid = document.getElementById("playlists-artist-grid");
}

beforeEach(() => {
  renderPlaylistsMarkup();
});

describe("[SF-WEB-74] Playlists tab — connection gating", () => {
  it("shows the connect hint and no grid when Yandex isn't connected", async () => {
    fetchSettingsStatus.mockResolvedValue({ yandex: { connected: false } });

    await activatePlaylistsTab();

    expect(els.playlistsConnectHint.hidden).toBe(false);
    expect(els.playlistsGrid.hidden).toBe(true);
    expect(fetchYandexPlaylists).not.toHaveBeenCalled();
  });

  it("hides the connect hint and loads playlists once connected", async () => {
    fetchSettingsStatus.mockResolvedValue({ yandex: { connected: true } });
    fetchYandexPlaylists.mockResolvedValue({
      type: "yandex_playlists",
      playlists: [{ id: "likes", kind: "likes", title: "Liked tracks", track_count: 0 }],
    });

    await activatePlaylistsTab();

    expect(els.playlistsConnectHint.hidden).toBe(true);
    expect(fetchYandexPlaylists).toHaveBeenCalledTimes(1);
    expect(els.playlistsGrid.hidden).toBe(false);
  });
});

describe("[SF-WEB-74] Playlist cards render with covers", () => {
  beforeEach(() => {
    fetchSettingsStatus.mockResolvedValue({ yandex: { connected: true } });
  });

  it("renders one card per playlist (plus likes), with a cover image", async () => {
    fetchYandexPlaylists.mockResolvedValue({
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
      playlists: [{ id: "9", kind: "playlist", title: "No Cover Here", track_count: 3 }],
    });

    await activatePlaylistsTab();

    const card = els.playlistsGrid.querySelector('[data-playlist-id="9"]');
    const img = card.querySelector(".playlist-card-cover");
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  });

  it("shows a toast and no grid when the playlists fetch fails", async () => {
    fetchYandexPlaylists.mockResolvedValue(null);

    await activatePlaylistsTab();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't load/i));
  });
});

describe("[SF-WEB-74] Picking a playlist card shows artist cards", () => {
  beforeEach(() => {
    fetchSettingsStatus.mockResolvedValue({ yandex: { connected: true } });
    fetchYandexPlaylists.mockResolvedValue({
      playlists: [{ id: "7", kind: "playlist", title: "Road Trip", track_count: 2 }],
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
