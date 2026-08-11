import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./game-board.js", () => ({
  renderBoard: vi.fn(),
  zoomBoard: vi.fn(),
  fitBoard: vi.fn(),
  mountBoard: vi.fn(),
  unmountBoard: vi.fn(),
}));
vi.mock("../ui/autocomplete.js", () => ({ attachGeniusAutocomplete: vi.fn() }));
vi.mock("../ui/router.js", () => ({
  navigateToSurface: vi.fn(),
  onSurfaceChange: vi.fn(),
  getCurrentSurface: vi.fn(() => "game"),
  SURFACE_GAME: "game",
}));
vi.mock("../ui/toast.js", () => ({ showToast: vi.fn() }));
vi.mock("../api/net.js", () => ({ apiFetch: vi.fn() }));
vi.mock("./game-graph.js", () => ({ fetchNeighbours: vi.fn(async () => null) }));
vi.mock("./game-api.js", () => ({
  createChallenge: vi.fn(async () => null),
  submitChain: vi.fn(async () => null),
  fetchLeaderboard: vi.fn(async () => null),
  fetchDailyChallenge: vi.fn(async () => null),
  fetchDailyChallengeState: vi.fn(async () => ({ status: "none", daily: null })),
  checkLink: vi.fn(async () => ({ linked: true })),
}));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  setStartArtist,
  setGoalArtist,
  commitHop,
  commitTypedHop,
  undoLast,
  resetGame,
  giveUpGame,
  lockIn,
  setupConnectMode,
  _currentChain,
  serializeGameShareState,
  parseGameShareState,
  shareCurrentChallenge,
  setupGameLandingPanel,
  startChallengeByRefs,
  startFromSetup,
} from "./connect.js";
import { checkLink } from "./game-api.js";
import { showToast } from "../ui/toast.js";
import { attachGeniusAutocomplete } from "../ui/autocomplete.js";
import { apiFetch } from "../api/net.js";
import { fetchNeighbours } from "./game-graph.js";
import {
  createChallenge,
  submitChain,
  fetchLeaderboard,
  fetchDailyChallenge,
  fetchDailyChallengeState,
} from "./game-api.js";
import { navigateToSurface } from "../ui/router.js";

function pickStart(name, id) {
  attachGeniusAutocomplete.mock.calls[0][2](name, null, id);
}
function pickGoal(name, id) {
  attachGeniusAutocomplete.mock.calls[1][2](name, null, id);
}
function startPair(from = ["Drake", 100], to = ["Adele", 900]) {
  pickStart(from[0], from[1]);
  pickGoal(to[0], to[1]);
  els.connectStartBtn.click();
}

function fixtureHtml() {
  return `
    <div id="connect-surface" hidden>
      <button id="connect-endpoints-summary">
        <span id="connect-title-start"></span>
        <span id="connect-title-goal"></span>
      </button>
      <span id="connect-par-pill" hidden>PAR <b id="connect-par-value"></b></span>
      <b id="connect-timer-value"></b>
      <div id="connect-endpoints" hidden>
        <input id="connect-start-input" /><div id="connect-start-ac"></div>
        <input id="connect-goal-input" /><div id="connect-goal-ac"></div>
        <button id="connect-start-btn" disabled></button>
      </div>
      <button id="connect-zoom-in"></button>
      <button id="connect-zoom-out"></button>
      <button id="connect-fit"></button>
      <div id="connect-canvas"></div>
      <p id="connect-stage-empty"></p>
      <b id="connect-hops-value"></b>
      <span id="connect-rival-pill" hidden><span id="connect-rival-text"></span></span>
      <input id="connect-add-input" /><div id="connect-add-ac"></div>
      <button id="connect-add-btn"></button>
      <ol id="connect-line-list"></ol>
      <details id="connect-browse" hidden>
        <summary id="connect-browse-label"></summary>
        <div id="connect-browse-chips"></div>
      </details>
      <div id="connect-leaderboard" hidden></div>
      <div id="connect-finish-label"></div>
      <p id="connect-finish-detail" hidden></p>
      <span id="connect-finish-score"></span>
      <button id="connect-lockin" disabled></button>
      <button id="connect-undo"></button>
      <button id="connect-reset"></button>
      <button id="connect-give-up"></button>
      <button id="connect-share"></button>
    </div>
  `;
}

function bindEls() {
  els.connectSurface = document.getElementById("connect-surface");
  els.connectTitleStart = document.getElementById("connect-title-start");
  els.connectTitleGoal = document.getElementById("connect-title-goal");
  els.connectParPill = document.getElementById("connect-par-pill");
  els.connectParValue = document.getElementById("connect-par-value");
  els.connectRivalPill = document.getElementById("connect-rival-pill");
  els.connectRivalText = document.getElementById("connect-rival-text");
  els.connectTimerValue = document.getElementById("connect-timer-value");
  els.connectHopsValue = document.getElementById("connect-hops-value");
  els.connectEndpoints = document.getElementById("connect-endpoints");
  els.connectEndpointsSummary = document.getElementById("connect-endpoints-summary");
  els.connectStartInput = document.getElementById("connect-start-input");
  els.connectStartAc = document.getElementById("connect-start-ac");
  els.connectGoalInput = document.getElementById("connect-goal-input");
  els.connectGoalAc = document.getElementById("connect-goal-ac");
  els.connectStartBtn = document.getElementById("connect-start-btn");
  els.connectCanvas = document.getElementById("connect-canvas");
  els.connectStageEmpty = document.getElementById("connect-stage-empty");
  els.connectZoomIn = document.getElementById("connect-zoom-in");
  els.connectZoomOut = document.getElementById("connect-zoom-out");
  els.connectFit = document.getElementById("connect-fit");
  els.connectAddInput = document.getElementById("connect-add-input");
  els.connectAddAc = document.getElementById("connect-add-ac");
  els.connectAddBtn = document.getElementById("connect-add-btn");
  els.connectLineList = document.getElementById("connect-line-list");
  els.connectBrowse = document.getElementById("connect-browse");
  els.connectBrowseLabel = document.getElementById("connect-browse-label");
  els.connectBrowseChips = document.getElementById("connect-browse-chips");
  els.connectUndo = document.getElementById("connect-undo");
  els.connectReset = document.getElementById("connect-reset");
  els.connectGiveUp = document.getElementById("connect-give-up");
  els.connectShare = document.getElementById("connect-share");
  els.connectLockin = document.getElementById("connect-lockin");
  els.connectFinishLabel = document.getElementById("connect-finish-label");
  els.connectFinishScore = document.getElementById("connect-finish-score");
  els.connectFinishDetail = document.getElementById("connect-finish-detail");
  els.connectLeaderboard = document.getElementById("connect-leaderboard");
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = fixtureHtml();
  bindEls();
  showToast.mockClear();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: false, json: async () => null });
  fetchNeighbours.mockClear();
  fetchNeighbours.mockImplementation(async () => null);
  createChallenge.mockClear();
  createChallenge.mockImplementation(async () => null);
  submitChain.mockClear();
  submitChain.mockImplementation(async () => null);
  fetchLeaderboard.mockClear();
  fetchLeaderboard.mockImplementation(async () => null);
  fetchDailyChallenge.mockClear();
  fetchDailyChallenge.mockImplementation(async () => null);
  fetchDailyChallengeState.mockClear();
  fetchDailyChallengeState.mockImplementation(async () => ({ status: "none", daily: null }));
  checkLink.mockClear();
  checkLink.mockImplementation(async () => ({ linked: true }));
  State.connect = {
    startName: "",
    goalName: "",
    game: null,
    photos: {},
    ids: {},
    frontier: null,
    rivalBanner: null,
    par: null,
    submitted: false,
  };
  setupConnectMode();
});

describe("empty state", () => {
  it("hands the stage to the setup screen and disables the in-game controls", () => {
    expect(els.connectStageEmpty.hidden).toBe(true);
    expect(els.connectAddInput.disabled).toBe(true);
    expect(els.connectAddBtn.disabled).toBe(true);
    expect(els.connectUndo.disabled).toBe(true);
    expect(els.connectReset.disabled).toBe(true);
    expect(els.connectGiveUp.disabled).toBe(true);
  });
});

describe("setStartArtist / setGoalArtist", () => {
  it("builds a chain once both are set and shows it in the head", async () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    await flush();
    expect(_currentChain()).not.toBeNull();
    expect(els.connectTitleStart.textContent).toBe("Drake");
    expect(els.connectTitleGoal.textContent).toBe("Adele");
    expect(els.connectStageEmpty.hidden).toBe(true);
    expect(els.connectAddInput.disabled).toBe(false);
  });

  it("collapses the endpoint fields into a summary once both are set", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    expect(els.connectEndpoints.hidden).toBe(true);
    expect(els.connectEndpointsSummary.hidden).toBe(false);
    expect(els.connectEndpointsSummary.innerHTML).toContain("Drake");
    expect(els.connectEndpointsSummary.innerHTML).toContain("Adele");
  });

  it("[design: ветвящийся веб] renders the current line (start→focus) in the panel, marking the focus", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
    const walked = els.connectLineList.querySelectorAll(".clp-row:not(.is-ghost)");
    expect(walked.length).toBe(2);
    expect(walked[0].querySelector(".clp-row-name").textContent).toBe("Drake");
    expect(walked[0].querySelector(".clp-row-sub").textContent).toBe("the origin");
    expect(walked[1].querySelector(".clp-row-name").textContent).toBe("Rihanna");
    expect(walked[1].querySelector(".clp-row-sub").textContent).toBe("branching from here");
    expect(walked[1].classList.contains("is-focus")).toBe(true);
  });

  it("[SF-GAME-54] показывает цель призрачной строкой, пока до неё не дошли", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
    const ghost = els.connectLineList.querySelector(".clp-row.is-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost.querySelector(".clp-row-name").textContent).toBe("Adele");
    expect(ghost.querySelector(".clp-row-sub").textContent).toBe("the target");
    expect(ghost.dataset.name).toBeUndefined();
  });

  it("[SF-GAME-54] призрака нет, когда цель уже достигнута", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Adele");
    expect(els.connectLineList.querySelector(".clp-row.is-ghost")).toBeNull();
  });

  it("[design: ветвящийся веб] shows the goal as 'reached' on the line once completed", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
    commitHop("Adele");
    const rows = [...els.connectLineList.querySelectorAll(".clp-row")];
    const goalRow = rows.find((r) => r.querySelector(".clp-row-name").textContent === "Adele");
    expect(goalRow.querySelector(".clp-row-sub").textContent).toBe("reached");
  });

  it("[design: ветвящийся веб] clicking a line row re-focuses that node (branch point)", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
    const drakeRow = [...els.connectLineList.querySelectorAll(".clp-row")].find(
      (r) => r.dataset.name === "Drake",
    );
    drakeRow.click();
    expect(_currentChain().focus).toBe("Drake");
  });

  it("[design: PAR pill] shows the challenge's ideal length once the challenge resolves", async () => {
    createChallenge.mockImplementation(async () => ({
      id: 7,
      from: 100,
      to: 900,
      role_mask: 0,
      kind: "custom",
      optimal_len: 3,
    }));
    startPair(["Drake", 100], ["Adele", 900]);
    await flush();
    expect(els.connectParPill.hidden).toBe(false);
    expect(els.connectParValue.textContent).toBe("3");
  });

  it("[design: or pick a rival] shows the rival banner set from the landing panel, hides it on a fresh chain", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    State.connect.rivalBanner = { name: "Alice", score: 950 };
    resetGame();
    expect(els.connectRivalPill.hidden).toBe(false);
    expect(els.connectRivalText.textContent).toBe("Chasing Alice · 950");

    setGoalArtist("Rosalía");
    expect(els.connectRivalPill.hidden).toBe(true);
  });

  it("re-expands on click without losing the chain", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
    els.connectEndpointsSummary.click();
    expect(els.connectEndpoints.hidden).toBe(false);
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake", "Rihanna"]);
  });

  it("[fix] re-expanding (Change) fills both fields with the CURRENT endpoints, not blank placeholders", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    els.connectStartInput.value = "";
    els.connectGoalInput.value = "";

    els.connectEndpointsSummary.click();
    expect(els.connectStartInput.value).toBe("Drake");
    expect(els.connectGoalInput.value).toBe("Adele");
  });
});

describe("[SF-GAME-48] явный старт с экрана настройки", () => {
  it("выбор обоих концов в автокомплите НЕ начинает партию", async () => {
    pickStart("Drake", 100);
    pickGoal("Adele", 900);
    await flush();
    expect(createChallenge).not.toHaveBeenCalled();
    expect(_currentChain()).toBeNull();
    expect(els.connectEndpoints.hidden).toBe(false);
  });

  it("Start начинает партию по тем же двум концам", async () => {
    pickStart("Drake", 100);
    pickGoal("Adele", 900);
    els.connectStartBtn.click();
    await flush();
    expect(createChallenge).toHaveBeenCalledWith(100, 900, 0);
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake"]);
  });

  it("Start недоступен, пока не выбраны оба конца", () => {
    expect(els.connectStartBtn.disabled).toBe(true);
    pickStart("Drake", 100);
    expect(els.connectStartBtn.disabled).toBe(true);
    pickGoal("Adele", 900);
    expect(els.connectStartBtn.disabled).toBe(false);
  });

  it("в роли поповера (партия уже идёт) пик коммитит сразу, без Start", async () => {
    startPair(["Drake", 100], ["Adele", 900]);
    await flush();
    createChallenge.mockClear();
    pickGoal("Rosalía", 700);
    await flush();
    expect(createChallenge).toHaveBeenCalledWith(100, 700, 0);
  });
});

describe("challenge creation (design: real backend)", () => {
  it("attempts a challenge create once both endpoints have resolvable ids", async () => {
    startPair(["Drake", 100], ["Adele", 900]);
    await flush();
    expect(createChallenge).toHaveBeenCalledWith(100, 900, 0);
  });

  it("stores the returned challenge id on the model", async () => {
    createChallenge.mockImplementation(async () => ({
      id: 7,
      from: 100,
      to: 900,
      role_mask: 0,
      kind: "custom",
      optimal_len: 2,
    }));
    startPair(["Drake", 100], ["Adele", 900]);
    await flush();
    expect(_currentChain().challengeId).toBe(7);
  });

  it("resolves a typed (non-picked) endpoint's id via /api/v1/search before creating the challenge", async () => {
    apiFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ id: 100, name: "Drake", image: null }] }),
    }));
    els.connectStartInput.value = "Drake";
    pickGoal("Adele", 900);
    els.connectStartBtn.click();
    await flush();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/search?q=Drake"));
    expect(createChallenge).toHaveBeenCalledWith(100, 900, 0);
  });
});

describe("commitHop", () => {
  beforeEach(() => {
    startPair(["Drake", 100], ["Adele", 900]);
  });

  it("adds an intermediate hop and updates the hop count", async () => {
    await flush();
    const res = commitHop("Rihanna");
    expect(res.ok).toBe(true);
    expect(els.connectHopsValue.textContent).toBe("1");
  });

  it("clears the composer input on a successful commit", async () => {
    await flush();
    els.connectAddInput.value = "Rihanna";
    commitHop("Rihanna");
    expect(els.connectAddInput.value).toBe("");
  });

  it("does nothing when there is no active chain", () => {
    State.connect.game = null;
    expect(commitHop("Rihanna")).toBeNull();
  });

  it("[design: Lock in] reaching the goal completes the line but does NOT auto-submit", async () => {
    await flush();
    commitHop("Adele");
    await flush();
    expect(_currentChain().completed).toBe(true);
    expect(submitChain).not.toHaveBeenCalled();
    expect(els.connectLockin.disabled).toBe(false);
  });
});

describe("reaching the goal + Lock in (design: real backend submit)", () => {
  beforeEach(async () => {
    createChallenge.mockImplementation(async () => ({
      id: 7,
      from: 100,
      to: 900,
      role_mask: 0,
      kind: "custom",
      optimal_len: 1,
    }));
    startPair(["Drake", 100], ["Adele", 900]);
    await flush();
  });

  it("Lock in submits the real id chain and renders a revealed score", async () => {
    submitChain.mockImplementation(async () => ({
      valid: true,
      player_len: 1,
      optimal_len: 1,
      optimal_path: [100, 900],
      score: 1000,
      max_score: 1000,
      elo_before: 1200,
      elo_after: 1214,
      elo_delta: 14,
    }));
    commitHop("Adele");
    lockIn();
    await flush();
    expect(submitChain).toHaveBeenCalledWith(7, [100, 900], expect.any(Number));
    expect(els.connectFinishScore.textContent).toBe("1000");
    expect(els.connectFinishDetail.textContent).toContain("1000 / 1000");
    expect(els.connectLockin.textContent).toBe("Locked in");
  });

  it("clicking the Lock in button submits, same as calling lockIn()", async () => {
    submitChain.mockImplementation(async () => ({
      valid: true,
      player_len: 1,
      optimal_len: 1,
      optimal_path: [100, 900],
      score: 1000,
      max_score: 1000,
      elo_before: 1200,
      elo_after: 1214,
      elo_delta: 14,
    }));
    commitHop("Adele");
    els.connectLockin.click();
    await flush();
    expect(submitChain).toHaveBeenCalledTimes(1);
  });

  it("Lock in is a no-op until the line reaches the goal", async () => {
    commitHop("Rihanna");
    lockIn();
    await flush();
    expect(submitChain).not.toHaveBeenCalled();
  });

  it("fetches and renders the leaderboard after a valid submit", async () => {
    submitChain.mockImplementation(async () => ({
      valid: true,
      player_len: 1,
      optimal_len: 1,
      optimal_path: [100, 900],
      score: 1000,
      max_score: 1000,
      elo_before: 1200,
      elo_after: 1214,
      elo_delta: 14,
    }));
    fetchLeaderboard.mockImplementation(async () => ({
      entries: [{ user_id: 1, display_name: "Alice", score: 1000, hops: 1, ts: 1 }],
      next_cursor: null,
    }));
    commitHop("Adele");
    lockIn();
    await flush();
    expect(fetchLeaderboard).toHaveBeenCalledWith(7);
    expect(els.connectLeaderboard.hidden).toBe(false);
    expect(els.connectLeaderboard.innerHTML).toContain("Alice");
  });

  it("renders a rejected verdict honestly when the server disagrees", async () => {
    submitChain.mockImplementation(async () => ({
      valid: false,
      reason: "invalid_hop",
      invalid_hop_index: 0,
    }));
    commitHop("Adele");
    lockIn();
    await flush();
    expect(els.connectFinishScore.textContent).toBe("0");
    expect(els.connectFinishLabel.textContent).toContain("hop 1");
  });

  it("tells the player honestly when a hop's id can't be resolved, without a fake score", async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => null });
    commitHop("Rihanna");
    commitHop("Adele");
    lockIn();
    await flush();
    expect(submitChain).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toMatch(/can't be scored/i);
  });

  it("tells the player honestly when the challenge itself never resolved", async () => {
    createChallenge.mockImplementation(async () => null);
    els.connectStartInput.value = "Kendrick Lamar";
    pickGoal("SZA", 950);
    els.connectStartBtn.click();
    await flush();
    commitHop("SZA");
    lockIn();
    await flush();
    expect(submitChain).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
  });
});

describe("[game #2] commitTypedHop — live connection check", () => {
  beforeEach(async () => {
    createChallenge.mockImplementation(async () => ({
      id: 7,
      from: 100,
      to: 900,
      role_mask: 0,
      kind: "custom",
      optimal_len: 2,
    }));
    startPair(["Drake", 100], ["Adele", 900]);
    await flush();
    checkLink.mockClear();
    showToast.mockClear();
  });

  it("blocks a typed artist the server says isn't connected, without adding", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ id: 500, name: "Beyonce", image: null }] }),
    });
    checkLink.mockResolvedValue({ linked: false });
    await commitTypedHop("Beyonce");
    await flush();
    expect(checkLink).toHaveBeenCalledWith(100, 500);
    expect(showToast).toHaveBeenCalled();
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake"]);
  });

  it("adds a typed artist the server confirms is connected", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ id: 200, name: "Rihanna", image: null }] }),
    });
    checkLink.mockResolvedValue({ linked: true });
    await commitTypedHop("Rihanna");
    await flush();
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake", "Rihanna"]);
  });

  it("fails OPEN (adds anyway) when the check is unavailable (linked null)", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ id: 200, name: "Rihanna", image: null }] }),
    });
    checkLink.mockResolvedValue({ linked: null });
    await commitTypedHop("Rihanna");
    await flush();
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake", "Rihanna"]);
  });

  it("skips the server check for a collaborator already shown in the frontier (fast path)", async () => {
    State.connect.frontier = {
      centerName: "Drake",
      loading: false,
      neighbours: [{ id: 200, name: "Rihanna", image: null }],
    };
    await commitTypedHop("Rihanna");
    await flush();
    expect(checkLink).not.toHaveBeenCalled();
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake", "Rihanna"]);
  });
});

describe("giveUp", () => {
  beforeEach(() => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
  });

  it("reveals the chain-so-far without submitting", async () => {
    giveUpGame();
    await flush();
    expect(_currentChain().gaveUp).toBe(true);
    expect(submitChain).not.toHaveBeenCalled();
    expect(els.connectFinishLabel.textContent).toMatch(/gave up/i);
  });

  it("disables further hops after giving up", () => {
    giveUpGame();
    expect(els.connectAddInput.disabled).toBe(true);
  });

  it("give-up button is disabled with zero hops", () => {
    resetGame();
    expect(els.connectGiveUp.disabled).toBe(true);
  });
});

describe("undoLast / resetGame", () => {
  beforeEach(() => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
  });

  it("undoLast removes the last-added node", () => {
    undoLast();
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake"]);
    expect(els.connectUndo.disabled).toBe(true);
  });

  it("resetGame clears the web back to just the start", () => {
    resetGame();
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake"]);
    expect(els.connectReset.disabled).toBe(true);
  });
});

describe("browse (secondary click-to-expand)", () => {
  beforeEach(() => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
  });

  it("shows the unavailable message with no resolvable id for the tail", async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => null });
    await flush();
    expect(els.connectBrowse.hidden).toBe(false);
    expect(els.connectBrowseChips.innerHTML).toContain("type a name above");
  });

  it("fetches and renders real neighbours once the tail has a numeric id", async () => {
    fetchNeighbours.mockImplementation(async () => ({
      seedId: 100,
      seedName: "Drake",
      neighbours: [
        { id: 200, name: "Rihanna", image: null },
        { id: 900, name: "Adele", image: null },
      ],
    }));
    const startCb = attachGeniusAutocomplete.mock.calls[0][2];
    startCb("Drake", null, 100);
    await flush();
    expect(els.connectBrowseChips.innerHTML).toContain("Rihanna");
    expect(els.connectBrowseChips.innerHTML).toContain("Adele");
  });

  it("marks the goal's own chip distinctly", async () => {
    fetchNeighbours.mockImplementation(async () => ({
      seedId: 100,
      seedName: "Drake",
      neighbours: [{ id: 900, name: "Adele", image: null }],
    }));
    const startCb = attachGeniusAutocomplete.mock.calls[0][2];
    const goalCb = attachGeniusAutocomplete.mock.calls[1][2];
    goalCb("Adele", null, 900);
    startCb("Drake", null, 100);
    await flush();
    expect(els.connectBrowseChips.innerHTML).toContain("cb-chip--goal");
  });

  it("clicking a chip commits it as a hop via the same pipeline as typed entry", async () => {
    fetchNeighbours.mockImplementation(async () => ({
      seedId: 100,
      seedName: "Drake",
      neighbours: [{ id: 200, name: "Rihanna", image: null }],
    }));
    const startCb = attachGeniusAutocomplete.mock.calls[0][2];
    startCb("Drake", null, 100);
    await flush();
    const chip = els.connectBrowseChips.querySelector(".cb-chip");
    expect(chip).not.toBeNull();
    chip.click();
    expect(_currentChain().nodes.map((n) => n.name)).toEqual(["Drake", "Rihanna"]);
  });

  it("hides once the round is over", async () => {
    submitChain.mockImplementation(async () => ({ valid: false, reason: "endpoint_mismatch" }));
    commitHop("Adele");
    await flush();
    expect(els.connectBrowse.hidden).toBe(true);
  });
});

describe("stopwatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 0:00 with no active chain", () => {
    expect(els.connectTimerValue.textContent).toBe("0:00");
  });

  it("ticks forward while the round is open", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    vi.advanceTimersByTime(7500);
    expect(els.connectTimerValue.textContent).toBe("0:07");
  });

  it("freezes once the player gives up", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
    vi.advanceTimersByTime(9000);
    giveUpGame();
    const at = els.connectTimerValue.textContent;
    vi.advanceTimersByTime(10000);
    expect(els.connectTimerValue.textContent).toBe(at);
  });
});

describe("[SF-GAME-05] serializeGameShareState / parseGameShareState (pure)", () => {
  it("round-trips from/to through URLSearchParams", () => {
    const params = serializeGameShareState({ from: "Drake", to: "Adele" });
    expect(params.get("from")).toBe("Drake");
    expect(params.get("to")).toBe("Adele");
    expect(parseGameShareState(params.toString())).toEqual({ from: "Drake", to: "Adele" });
  });

  it("omits a missing side instead of encoding an empty string", () => {
    const params = serializeGameShareState({ from: "Drake" });
    expect(params.has("to")).toBe(false);
  });

  it("parseGameShareState never throws on garbage/empty input", () => {
    expect(parseGameShareState("")).toEqual({ from: null, to: null });
    expect(parseGameShareState("?nonsense=1")).toEqual({ from: null, to: null });
  });
});

describe("[SF-GAME-05] shareCurrentChallenge", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it("does nothing without an active game (no endpoints set yet)", () => {
    shareCurrentChallenge();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies a #/game?from=..&to=.. link once both endpoints are set", async () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    shareCurrentChallenge();
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const url = new URL(navigator.clipboard.writeText.mock.calls[0][0]);
    expect(url.hash).toBe("#/game");
    expect(url.searchParams.get("from")).toBe("Drake");
    expect(url.searchParams.get("to")).toBe("Adele");
    expect(showToast).toHaveBeenCalledWith("🔗 Link copied!", 2000, true);
  });

  it("connect-share is disabled until both endpoints are set, then enabled", () => {
    expect(els.connectShare.disabled).toBe(true);
    setStartArtist("Drake");
    setGoalArtist("Adele");
    expect(els.connectShare.disabled).toBe(false);
  });
});

describe("[SF-GAME-05] deep-link load — #/game?from=..&to=.. pre-fills on setup", () => {
  const realLocation = window.location;

  afterEach(() => {
    window.location = realLocation;
  });

  it("pre-fills both fields and creates the challenge, same as typing them", async () => {
    delete window.location;
    window.location = new URL("https://example.test/?from=Drake&to=Adele#/game");
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ id: 1, name: "Drake" }] }),
    });
    createChallenge.mockResolvedValue({ id: 7, from: 1, to: 2, optimal_len: 2 });

    document.body.innerHTML = fixtureHtml();
    bindEls();
    State.connect = {
      startName: "",
      goalName: "",
      game: null,
      photos: {},
      ids: {},
      frontier: null,
    };
    setupConnectMode();
    await flush();

    expect(els.connectStartInput.value).toBe("Drake");
    expect(els.connectGoalInput.value).toBe("Adele");
    expect(State.connect.game).toBeTruthy();
    expect(State.connect.game.start).toBe("Drake");
    expect(State.connect.game.goal).toBe("Adele");
  });

  it("does nothing when the link is missing one side", async () => {
    delete window.location;
    window.location = new URL("https://example.test/?from=Drake#/game");

    document.body.innerHTML = fixtureHtml();
    bindEls();
    State.connect = {
      startName: "",
      goalName: "",
      game: null,
      photos: {},
      ids: {},
      frontier: null,
    };
    setupConnectMode();
    await flush();

    expect(els.connectStartInput.value).toBe("");
    expect(State.connect.game).toBeNull();
  });
});

describe("[design: challenge setup on the landing page] setupGameLandingPanel", () => {
  function gameFixtureHtml() {
    return `
      <span id="hero-game-from-avatar"></span>
      <input id="hero-game-from-input" /><div id="hero-game-from-ac"></div>
      <span id="hero-game-to-avatar"></span>
      <input id="hero-game-to-input" /><div id="hero-game-to-ac"></div>
      <button id="btn-hero-start-challenge"></button>
      <div id="hero-game-daily">
        <div id="hero-game-daily-pair" hidden>
        <span id="hero-game-daily-from-avatar"></span><span id="hero-game-daily-from-name"></span>
        <span id="hero-game-daily-to-avatar"></span><span id="hero-game-daily-to-name"></span>
        </div>
        <span id="hero-game-daily-state"></span>
        <button id="btn-hero-daily-retry" hidden></button>
        <button id="btn-hero-play-daily"></button>
      </div>
      <div id="hero-game-rivals" hidden><div id="hero-game-rivals-list"></div></div>
      <div id="hero-game-divider" hidden></div>
    `;
  }

  function bindGameEls() {
    els.heroGameFromAvatar = document.getElementById("hero-game-from-avatar");
    els.heroGameFromInput = document.getElementById("hero-game-from-input");
    els.heroGameFromAc = document.getElementById("hero-game-from-ac");
    els.heroGameToAvatar = document.getElementById("hero-game-to-avatar");
    els.heroGameToInput = document.getElementById("hero-game-to-input");
    els.heroGameToAc = document.getElementById("hero-game-to-ac");
    els.btnHeroStartChallenge = document.getElementById("btn-hero-start-challenge");
    els.heroGameDaily = document.getElementById("hero-game-daily");
    els.heroGameDailyPair = document.getElementById("hero-game-daily-pair");
    els.heroGameDailyState = document.getElementById("hero-game-daily-state");
    els.btnHeroDailyRetry = document.getElementById("btn-hero-daily-retry");
    els.heroGameDailyFromAvatar = document.getElementById("hero-game-daily-from-avatar");
    els.heroGameDailyFromName = document.getElementById("hero-game-daily-from-name");
    els.heroGameDailyToAvatar = document.getElementById("hero-game-daily-to-avatar");
    els.heroGameDailyToName = document.getElementById("hero-game-daily-to-name");
    els.btnHeroPlayDaily = document.getElementById("btn-hero-play-daily");
    els.heroGameRivals = document.getElementById("hero-game-rivals");
    els.heroGameRivalsList = document.getElementById("hero-game-rivals-list");
    els.heroGameDivider = document.getElementById("hero-game-divider");
  }

  beforeEach(() => {
    document.body.innerHTML = gameFixtureHtml();
    bindGameEls();
    State.connect = {
      startName: "",
      goalName: "",
      game: null,
      photos: {},
      ids: {},
      frontier: null,
      rivalBanner: null,
    };
    setupGameLandingPanel();
  });

  it("does nothing and toasts when either field is empty", () => {
    els.heroGameFromInput.value = "Drake";
    els.btnHeroStartChallenge.click();
    expect(showToast).toHaveBeenCalledWith("Enter both artist names.");
    expect(navigateToSurface).not.toHaveBeenCalled();
  });

  it("sets both endpoints and navigates to #/game once both fields are filled", () => {
    els.heroGameFromInput.value = "Drake";
    els.heroGameToInput.value = "Adele";
    els.btnHeroStartChallenge.click();
    expect(State.connect.startName).toBe("Drake");
    expect(State.connect.goalName).toBe("Adele");
    expect(navigateToSurface).toHaveBeenCalledWith("game");
  });

  it("Enter in the 'from' field moves focus to 'to' instead of submitting", () => {
    els.heroGameFromInput.value = "Drake";
    els.heroGameFromInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(els.heroGameToInput);
    expect(navigateToSurface).not.toHaveBeenCalled();
  });

  it("Enter in the 'to' field submits, same as clicking Start challenge", () => {
    els.heroGameFromInput.value = "Drake";
    els.heroGameToInput.value = "Adele";
    els.heroGameToInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(navigateToSurface).toHaveBeenCalledWith("game");
  });

  it("attaches autocomplete to both fields and renders a photo avatar on pick", async () => {
    expect(attachGeniusAutocomplete).toHaveBeenCalledWith(
      els.heroGameFromInput,
      els.heroGameFromAc,
      expect.any(Function),
    );
    const onSelect = attachGeniusAutocomplete.mock.calls.find(
      (c) => c[0] === els.heroGameFromInput,
    )[2];
    onSelect("Drake", "https://example.test/drake.jpg", 42);
    expect(els.heroGameFromInput.value).toBe("Drake");
    expect(els.heroGameFromAvatar.innerHTML).toContain("img");
    expect(State.connect.ids.Drake).toBe(42);
  });

  it("falls back to an initial letter when a pick has no photo", () => {
    const onSelect = attachGeniusAutocomplete.mock.calls.find(
      (c) => c[0] === els.heroGameToInput,
    )[2];
    onSelect("Adele", null, 7);
    expect(els.heroGameToAvatar.textContent).toBe("A");
  });

  describe("[design: Today's Challenge + or pick a rival]", () => {
    const DAILY = {
      id: 77,
      from: 100,
      to: 900,
      role_mask: 15,
      kind: "daily",
      optimal_len: 2,
      from_name: "Drake",
      from_image: "https://example.test/drake.jpg",
      to_name: "Adele",
    };

    async function flush() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("[SF-GAME-60] 404 — слот виден и говорит, что дейли ещё не опубликован", async () => {
      fetchDailyChallengeState.mockImplementation(async () => ({ status: "none", daily: null }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();
      expect(els.heroGameDaily.hidden).toBe(false);
      expect(els.heroGameDailyPair.hidden).toBe(true);
      expect(els.heroGameDailyState.hidden).toBe(false);
      expect(els.heroGameDailyState.textContent).toMatch(/not published|no challenge published/i);
      expect(els.btnHeroDailyRetry.hidden).toBe(true);
      expect(els.heroGameRivals.hidden).toBe(true);
    });

    it("[SF-GAME-60] сбой сервиса — другая формулировка и кнопка Retry", async () => {
      fetchDailyChallengeState.mockImplementation(async () => ({
        status: "unavailable",
        daily: null,
      }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();
      expect(els.heroGameDaily.hidden).toBe(false);
      expect(els.heroGameDailyPair.hidden).toBe(true);
      expect(els.heroGameDailyState.textContent).toMatch(/couldn't reach/i);
      expect(els.heroGameDailyState.classList.contains("is-error")).toBe(true);
      expect(els.btnHeroDailyRetry.hidden).toBe(false);
    });

    it("[SF-GAME-60] Retry перезапрашивает дейли и показывает пару", async () => {
      fetchDailyChallengeState.mockImplementation(async () => ({
        status: "unavailable",
        daily: null,
      }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();

      fetchDailyChallengeState.mockImplementation(async () => ({ status: "ok", daily: DAILY }));
      els.btnHeroDailyRetry.click();
      await flush();

      expect(els.heroGameDailyPair.hidden).toBe(false);
      expect(els.heroGameDailyFromName.textContent).toBe("Drake");
      expect(els.btnHeroDailyRetry.hidden).toBe(true);
    });

    it("renders the real daily pair once the daily resolves", async () => {
      fetchDailyChallengeState.mockImplementation(async () => ({ status: "ok", daily: DAILY }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();
      expect(els.heroGameDailyPair.hidden).toBe(false);
      expect(els.heroGameDailyFromName.textContent).toBe("Drake");
      expect(els.heroGameDailyToName.textContent).toBe("Adele");
      expect(els.heroGameDailyFromAvatar.innerHTML).toContain("img");
      expect(els.heroGameDivider.hidden).toBe(false);
    });

    it("Play sets both endpoints from the daily challenge and navigates, without a rival banner", async () => {
      fetchDailyChallengeState.mockImplementation(async () => ({ status: "ok", daily: DAILY }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();

      els.btnHeroPlayDaily.click();
      expect(State.connect.startName).toBe("Drake");
      expect(State.connect.goalName).toBe("Adele");
      expect(State.connect.ids.Drake).toBe(100);
      expect(State.connect.ids.Adele).toBe(900);
      expect(navigateToSurface).toHaveBeenCalledWith("game");
      expect(State.connect.rivalBanner).toBeNull();
    });

    it("renders rival chips from the daily challenge's own leaderboard", async () => {
      fetchDailyChallengeState.mockImplementation(async () => ({ status: "ok", daily: DAILY }));
      fetchLeaderboard.mockImplementation(async () => ({
        entries: [
          { user_id: 1, display_name: "Alice", score: 950, hops: 2, ts: 1 },
          { user_id: 2, display_name: "Bob", score: 800, hops: 3, ts: 2 },
        ],
        next_cursor: null,
      }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();

      expect(fetchLeaderboard).toHaveBeenCalledWith(77);
      expect(els.heroGameRivals.hidden).toBe(false);
      const chips = els.heroGameRivalsList.querySelectorAll(".rival-chip");
      expect(chips.length).toBe(2);
      expect(chips[0].textContent).toContain("Alice");
      expect(chips[0].textContent).toContain("950");
    });

    it("picking a rival starts the SAME daily challenge and sets the rival banner", async () => {
      fetchDailyChallengeState.mockImplementation(async () => ({ status: "ok", daily: DAILY }));
      fetchLeaderboard.mockImplementation(async () => ({
        entries: [{ user_id: 1, display_name: "Alice", score: 950, hops: 2, ts: 1 }],
        next_cursor: null,
      }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();

      els.heroGameRivalsList.querySelector(".rival-chip").click();
      expect(State.connect.startName).toBe("Drake");
      expect(State.connect.goalName).toBe("Adele");
      expect(navigateToSurface).toHaveBeenCalledWith("game");
      expect(State.connect.rivalBanner).toEqual({ name: "Alice", score: 950 });
    });

    it("stays hidden when the daily challenge has no leaderboard entries yet", async () => {
      fetchDailyChallenge.mockImplementation(async () => DAILY);
      fetchLeaderboard.mockImplementation(async () => ({ entries: [], next_cursor: null }));
      document.body.innerHTML = gameFixtureHtml();
      bindGameEls();
      setupGameLandingPanel();
      await flush();
      expect(els.heroGameRivals.hidden).toBe(true);
    });
  });
});

describe("setup form wiring", () => {
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("keeps the start button disabled until both endpoints are filled", () => {
    expect(els.connectStartBtn.disabled).toBe(true);

    els.connectStartInput.value = "Drake";
    els.connectStartInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(els.connectStartBtn.disabled).toBe(true);

    els.connectGoalInput.value = "Adele";
    els.connectGoalInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(els.connectStartBtn.disabled).toBe(false);
  });

  it("enables the button as soon as both endpoints are picked from the list", () => {
    pickStart("Drake", 100);
    expect(els.connectStartBtn.disabled).toBe(true);

    pickGoal("Adele", 900);
    expect(els.connectStartBtn.disabled).toBe(false);
  });

  it("writes the picked name back into the field", () => {
    pickStart("Drake", 100);
    expect(els.connectStartInput.value).toBe("Drake");

    pickGoal("Adele", 900);
    expect(els.connectGoalInput.value).toBe("Adele");
  });

  it("Enter in the setup fields starts the round rather than editing an endpoint", () => {
    els.connectStartInput.value = "Drake";
    els.connectGoalInput.value = "Adele";

    key(els.connectStartInput, "Enter");

    expect(els.connectSurface).toBeTruthy();
  });

  it("Enter on an empty field does nothing", () => {
    els.connectStartInput.value = "   ";
    expect(() => key(els.connectStartInput, "Enter")).not.toThrow();
  });

  it("Enter in the add-hop field commits what was typed", () => {
    startPair();
    els.connectAddInput.value = "Future";

    key(els.connectAddInput, "Enter");

    expect(els.connectAddInput).toBeTruthy();
  });
});

describe("board controls", () => {
  it("zooms in, out and fits from the toolbar", async () => {
    const { zoomBoard, fitBoard } = await import("./game-board.js");
    startPair();

    els.connectZoomIn.click();
    expect(zoomBoard).toHaveBeenCalledWith(1.25);

    els.connectZoomOut.click();
    expect(zoomBoard).toHaveBeenCalledWith(0.8);

    els.connectFit.click();
    expect(fitBoard).toHaveBeenCalled();
  });
});

describe("chain list and browse chips", () => {
  it("ignores a click that misses a row", () => {
    startPair();
    expect(() =>
      els.connectLineList.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();
  });

  it("ignores a browse click that misses a chip", () => {
    startPair();
    expect(() =>
      els.connectBrowseChips.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();
  });
});

describe("setupGameLandingPanel", () => {
  it("refuses to start without both names", () => {
    els.heroGameFromInput.value = "Drake";
    els.heroGameToInput.value = "";

    els.btnHeroStartChallenge.click();

    expect(showToast).toHaveBeenCalled();
    expect(navigateToSurface).not.toHaveBeenCalled();
  });

  it("navigates to the game once both names are given", () => {
    els.heroGameFromInput.value = "Drake";
    els.heroGameToInput.value = "Adele";

    els.btnHeroStartChallenge.click();

    expect(navigateToSurface).toHaveBeenCalled();
  });
});

describe("round actions — guards when no round is running", () => {
  it("undo, reset, give up, lock in and share all no-op in setup", () => {
    expect(() => {
      undoLast();
      resetGame();
      giveUpGame();
      lockIn();
      shareCurrentChallenge();
    }).not.toThrow();
  });
});

describe("startChallengeByRefs", () => {
  it("ignores a call missing either endpoint", () => {
    startChallengeByRefs(null, { name: "Adele" });
    startChallengeByRefs({ name: "Drake" }, null);
    startChallengeByRefs({}, { name: "Adele" });

    expect(navigateToSurface).not.toHaveBeenCalled();
  });

  it("starts the round and navigates to the board", () => {
    startChallengeByRefs(
      { name: "Drake", id: 100, image: "http://img/d.jpg" },
      { name: "Adele", id: 900, image: "http://img/a.jpg" },
    );

    expect(navigateToSurface).toHaveBeenCalled();
    expect(_currentChain()).toBeTruthy();
  });

  it("works with bare names, without ids or photos", () => {
    startChallengeByRefs({ name: "Drake" }, { name: "Adele" });
    expect(navigateToSurface).toHaveBeenCalled();
  });

  it("records a rival banner when one is given", () => {
    startChallengeByRefs(
      { name: "Drake" },
      { name: "Adele" },
      {
        display_name: "Bob",
        score: 900,
      },
    );

    expect(navigateToSurface).toHaveBeenCalled();
  });
});

describe("shareCurrentChallenge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies a link that carries both endpoints", async () => {
    startPair();
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    shareCurrentChallenge();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("#/game"));
  });

  it("shows the link instead when there is no clipboard", () => {
    startPair();
    vi.stubGlobal("navigator", {});

    shareCurrentChallenge();

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("#/game"), 6000);
  });

  it("falls back to showing the link when the copy is refused", async () => {
    startPair();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    shareCurrentChallenge();
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("#/game"), 6000);
  });
});

describe("startFromSetup", () => {
  it("keeps the button disabled while one endpoint is missing", () => {
    els.connectStartInput.value = "Drake";
    els.connectStartInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(els.connectStartBtn.disabled).toBe(true);
  });

  it("asks for both endpoints if the action is reached anyway", () => {
    els.connectStartInput.value = "Drake";
    els.connectGoalInput.value = "";

    startFromSetup();

    expect(showToast).toHaveBeenCalled();
    expect(_currentChain()).toBeFalsy();
  });
});

describe("expandEndpoints", () => {
  it("puts the current endpoints back into the editable fields", () => {
    startPair(["Drake", 100], ["Adele", 900]);
    els.connectStartInput.value = "";
    els.connectGoalInput.value = "";

    els.connectEndpointsSummary.click();

    expect(els.connectStartInput.value).toBe("Drake");
    expect(els.connectGoalInput.value).toBe("Adele");
  });
});
