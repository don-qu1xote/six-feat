// ════════════════════════════════════════════════════════════════════════════
// game-windows.test.js — DOM-level coverage for the routed game windows
// controller (game-windows.js): surface show/hide + active nav, and each
// screen's data load (leaderboard scopes, profile + admin gating, challenge
// browser, season hub). game-api.js, the router, connect.js, autocomplete and
// toast are all mocked, so these drive the real render/route logic off a jsdom
// fixture with no network or vis.Network.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ui/router.js", () => ({
  onSurfaceChange: vi.fn(),
  getCurrentSurface: vi.fn(() => "game/leaderboard"),
  SURFACE_GAME_LEADERBOARD: "game/leaderboard",
  SURFACE_GAME_PROFILE: "game/profile",
  SURFACE_GAME_CHALLENGES: "game/challenges",
  SURFACE_GAME_SEASON: "game/season",
}));
vi.mock("../ui/autocomplete.js", () => ({ attachGeniusAutocomplete: vi.fn() }));
vi.mock("../ui/toast.js", () => ({ showToast: vi.fn() }));
vi.mock("./connect.js", () => ({ startChallengeByRefs: vi.fn() }));
vi.mock("./game-api.js", () => ({
  fetchProfile: vi.fn(async () => null),
  fetchPublicProfile: vi.fn(async () => null),
  fetchChallenges: vi.fn(async () => null),
  fetchSeason: vi.fn(async () => null),
  fetchLeaderboard: vi.fn(async () => null),
  fetchSeasonLeaderboard: vi.fn(async () => null),
  fetchAdminStatus: vi.fn(async () => false),
  publishDaily: vi.fn(async () => null),
}));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { onSurfaceChange } from "../ui/router.js";
import { startChallengeByRefs } from "./connect.js";
import { showToast } from "../ui/toast.js";
import {
  fetchProfile, fetchPublicProfile, fetchChallenges, fetchSeason,
  fetchLeaderboard, fetchSeasonLeaderboard, fetchAdminStatus, publishDaily,
} from "./game-api.js";
import { setupGameWindows } from "./game-windows.js";

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

const NAV = `<nav><a class="game-nav-link" data-surface="game/leaderboard"></a>
  <a class="game-nav-link" data-surface="game/profile"></a></nav>`;

function fixture() {
  return `
    ${NAV}
    <section id="game-leaderboard-surface" class="game-screen" hidden>
      <button id="lb-tab-season" class="is-active"></button>
      <button id="lb-tab-challenge"></button>
      <p id="lb-scope-label"></p>
      <ol id="lb-list"></ol>
      <p id="lb-empty" hidden></p>
    </section>
    <section id="game-profile-surface" class="game-screen" hidden>
      <div id="profile-signed-out" hidden></div>
      <div id="profile-card" hidden>
        <span id="pf-avatar"></span><h1 id="pf-name"></h1><span id="pf-rank"></span>
        <span id="pf-elo"></span><span id="pf-games"></span><span id="pf-badges"></span>
        <div id="pf-badge-list"></div><p id="pf-badges-empty" hidden></p>
        <ol id="pf-history"></ol><p id="pf-history-empty" hidden></p>
      </div>
      <section id="admin-panel" hidden>
        <input id="admin-from-input" /><div id="admin-from-ac"></div>
        <input id="admin-to-input" /><div id="admin-to-ac"></div>
        <button id="admin-publish-daily"></button>
        <p id="admin-status"></p>
      </section>
    </section>
    <section id="game-challenges-surface" class="game-screen" hidden>
      <button id="ch-tab-all" class="is-active"></button>
      <button id="ch-tab-daily"></button>
      <button id="ch-tab-custom"></button>
      <div id="ch-grid"></div>
      <p id="ch-empty" hidden></p>
      <button id="ch-more" hidden></button>
    </section>
    <section id="game-season-surface" class="game-screen" hidden>
      <h1 id="sn-name"></h1><span id="sn-countdown"></span><span id="sn-you" hidden></span>
      <span id="sn-progress-fill"></span><p id="sn-dates"></p>
      <ol id="sn-podium"></ol><p id="sn-podium-empty" hidden></p>
      <span id="sn-ach-count"></span><span id="sn-ach-hint"></span><div id="sn-ach-grid"></div>
    </section>
  `;
}

function bind() {
  const map = {
    gameLeaderboardSurface: "game-leaderboard-surface", lbTabSeason: "lb-tab-season",
    lbTabChallenge: "lb-tab-challenge", lbScopeLabel: "lb-scope-label", lbList: "lb-list", lbEmpty: "lb-empty",
    gameProfileSurface: "game-profile-surface", profileSignedOut: "profile-signed-out", profileCard: "profile-card",
    pfAvatar: "pf-avatar", pfName: "pf-name", pfRank: "pf-rank", pfElo: "pf-elo", pfGames: "pf-games",
    pfBadges: "pf-badges", pfBadgeList: "pf-badge-list", pfBadgesEmpty: "pf-badges-empty",
    pfHistory: "pf-history", pfHistoryEmpty: "pf-history-empty",
    gameChallengesSurface: "game-challenges-surface", chTabAll: "ch-tab-all", chTabDaily: "ch-tab-daily",
    chTabCustom: "ch-tab-custom", chGrid: "ch-grid", chEmpty: "ch-empty", chMore: "ch-more",
    gameSeasonSurface: "game-season-surface", snName: "sn-name", snCountdown: "sn-countdown", snYou: "sn-you",
    snProgressFill: "sn-progress-fill", snDates: "sn-dates", snPodium: "sn-podium", snPodiumEmpty: "sn-podium-empty",
    snAchCount: "sn-ach-count", snAchHint: "sn-ach-hint", snAchGrid: "sn-ach-grid",
    adminPanel: "admin-panel", adminFromInput: "admin-from-input", adminFromAc: "admin-from-ac",
    adminToInput: "admin-to-input", adminToAc: "admin-to-ac", adminPublishDaily: "admin-publish-daily",
    adminStatus: "admin-status",
  };
  for (const [k, id] of Object.entries(map)) els[k] = document.getElementById(id);
}

let applySurface;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = fixture();
  bind();
  State.connect = null;
  onSurfaceChange.mockImplementation(fn => { applySurface = fn; });
  setupGameWindows();
});

describe("surface routing", () => {
  it("shows only the active screen and marks its nav link", () => {
    applySurface("game/leaderboard");
    expect(els.gameLeaderboardSurface.hidden).toBe(false);
    expect(els.gameLeaderboardSurface.classList.contains("show")).toBe(true);
    expect(els.gameProfileSurface.hidden).toBe(true);
    const active = document.querySelector('.game-nav-link[data-surface="game/leaderboard"]');
    expect(active.classList.contains("is-active")).toBe(true);
  });

  it("hides all game screens on an unknown surface", () => {
    applySurface("graph");
    expect(els.gameLeaderboardSurface.hidden).toBe(true);
    expect(els.gameSeasonSurface.hidden).toBe(true);
  });
});

describe("leaderboard", () => {
  it("loads the season board by default", async () => {
    fetchSeason.mockResolvedValue({ season: { id: 3 } });
    fetchSeasonLeaderboard.mockResolvedValue({ entries: [
      { user_id: 1, display_name: "Alice", score: 900, hops: 2 },
    ] });
    applySurface("game/leaderboard");
    await flush();
    expect(fetchSeasonLeaderboard).toHaveBeenCalledWith(3, { limit: 50 });
    expect(els.lbList.innerHTML).toContain("Alice");
  });

  it("shows the empty state with no entries", async () => {
    fetchSeason.mockResolvedValue({ season: { id: 3 } });
    fetchSeasonLeaderboard.mockResolvedValue({ entries: [] });
    applySurface("game/leaderboard");
    await flush();
    expect(els.lbEmpty.hidden).toBe(false);
  });

  it("challenge tab needs an active challenge; empty otherwise", async () => {
    els.lbTabChallenge.click();
    await flush();
    expect(els.lbScopeLabel.textContent).toContain("Start a challenge");
    expect(fetchLeaderboard).not.toHaveBeenCalled();
  });

  it("challenge tab loads the current challenge's board when one is active", async () => {
    State.connect = { game: { challengeId: 7 } };
    fetchLeaderboard.mockResolvedValue({ entries: [{ user_id: 1, display_name: "Bob", score: 5, hops: 1 }] });
    els.lbTabChallenge.click();
    await flush();
    expect(fetchLeaderboard).toHaveBeenCalledWith(7, { limit: 50 });
    expect(els.lbList.innerHTML).toContain("Bob");
  });
});

describe("profile + admin gating", () => {
  it("shows the signed-out state when there's no profile", async () => {
    fetchProfile.mockResolvedValue(null);
    applySurface("game/profile");
    await flush();
    expect(els.profileSignedOut.hidden).toBe(false);
    expect(els.profileCard.hidden).toBe(true);
  });

  it("renders the card, badges and history when signed in", async () => {
    fetchProfile.mockResolvedValue({
      user_id: 5, display_name: "Al", avatar_url: null, elo: 1300, games: 4, rank: 2,
      achievements: [{ code: "first_win", title: "First win", descr: "..." }],
    });
    fetchPublicProfile.mockResolvedValue({ history: [
      { valid: true, score: 900, hops: 2, ts: 1 },
      { valid: false, hops: 0, ts: 2 },
    ] });
    applySurface("game/profile");
    await flush();
    expect(els.profileCard.hidden).toBe(false);
    expect(els.pfName.textContent).toBe("Al");
    expect(els.pfRank.textContent).toContain("#2");
    expect(els.pfBadges.textContent).toBe("1");
    expect(els.pfBadgeList.innerHTML).toContain("First win");
    expect(els.pfHistory.innerHTML).toContain("900");
  });

  it("keeps the admin panel hidden for a non-admin", async () => {
    fetchProfile.mockResolvedValue({ user_id: 5, display_name: "Al", elo: 1, games: 0, rank: 0, achievements: [] });
    fetchAdminStatus.mockResolvedValue(false);
    applySurface("game/profile");
    await flush();
    expect(els.adminPanel.hidden).toBe(true);
  });

  it("reveals the admin panel for an admin", async () => {
    fetchProfile.mockResolvedValue({ user_id: 5, display_name: "Al", elo: 1, games: 0, rank: 0, achievements: [] });
    fetchAdminStatus.mockResolvedValue(true);
    applySurface("game/profile");
    await flush();
    expect(els.adminPanel.hidden).toBe(false);
  });
});

describe("admin publish", () => {
  it("reports success and toasts", async () => {
    publishDaily.mockResolvedValue({ id: 42, optimal_len: 3 });
    els.adminPublishDaily.click();
    await flush();
    expect(publishDaily).toHaveBeenCalled();
    expect(els.adminStatus.textContent).toContain("#42");
    expect(showToast).toHaveBeenCalled();
  });

  it("reports failure without a toast", async () => {
    publishDaily.mockResolvedValue(null);
    els.adminPublishDaily.click();
    await flush();
    expect(els.adminStatus.textContent).toMatch(/Couldn't publish/i);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("challenges browser", () => {
  it("renders challenge cards and a Load more when there's a cursor", async () => {
    fetchChallenges.mockResolvedValue({
      challenges: [
        { id: 1, kind: "daily", optimal_len: 2, from: { id: 10, name: "A" }, to: { id: 20, name: "B" } },
      ],
      next_cursor: "100:1",
    });
    applySurface("game/challenges");
    await flush();
    expect(els.chGrid.innerHTML).toContain("A");
    expect(els.chMore.hidden).toBe(false);
  });

  it("shows the empty state with no challenges", async () => {
    fetchChallenges.mockResolvedValue({ challenges: [], next_cursor: null });
    applySurface("game/challenges");
    await flush();
    expect(els.chEmpty.hidden).toBe(false);
  });

  it("starting a card hands the endpoints to connect.js", async () => {
    fetchChallenges.mockResolvedValue({
      challenges: [{ id: 1, kind: "custom", optimal_len: 2, from: { id: 10, name: "A", image: "a.jpg" }, to: { id: 20, name: "B" } }],
      next_cursor: null,
    });
    applySurface("game/challenges");
    await flush();
    els.chGrid.querySelector(".ch-card").click();
    expect(startChallengeByRefs).toHaveBeenCalledWith(
      { name: "A", id: 10, image: "a.jpg" },
      { name: "B", id: 20, image: undefined },
    );
  });

  it("the Daily tab filters by kind", async () => {
    fetchChallenges.mockResolvedValue({ challenges: [], next_cursor: null });
    els.chTabDaily.click();
    await flush();
    expect(fetchChallenges).toHaveBeenLastCalledWith({ kind: "daily", cursor: "", limit: 24 });
  });
});

describe("season hub", () => {
  it("renders the season hero, podium and achievements (earned + locked)", async () => {
    const now = Math.floor(Date.now() / 1000);
    fetchSeason.mockResolvedValue({
      season: { id: 3, name: "Season 3", starts_ts: now - 100, ends_ts: now + 100 },
      podium: [{ user_id: 1, display_name: "Alice", score: 900 }],
      achievements: [
        { code: "first_win", title: "First win", descr: "win one" },
        { code: "veteran", title: "Veteran", descr: "play a lot" },
      ],
    });
    fetchProfile.mockResolvedValue({
      user_id: 5, display_name: "Al", elo: 1300, rank: 2,
      achievements: [{ code: "first_win" }],
    });
    applySurface("game/season");
    await flush();
    expect(els.snName.textContent).toBe("Season 3");
    expect(els.snPodium.innerHTML).toContain("Alice");
    expect(els.snAchCount.textContent).toBe("1 / 2");
    expect(els.snYou.hidden).toBe(false);
    const earned = els.snAchGrid.querySelectorAll(".sn-ach.is-earned");
    expect(earned.length).toBe(1);
  });

  it("shows the podium empty state with no scores", async () => {
    fetchSeason.mockResolvedValue({ season: { id: 3, name: "S", starts_ts: 0, ends_ts: 0 }, podium: [], achievements: [] });
    fetchProfile.mockResolvedValue(null);
    applySurface("game/season");
    await flush();
    expect(els.snPodiumEmpty.hidden).toBe(false);
  });
});
