// ════════════════════════════════════════════════════════════════════════════
// connect.test.js — [SF-GAME-01/15/17] DOM-level coverage for the "Connect"
// game surface controller (connect.js). Complements connect-model.test.js
// (pure model): this file drives the actual render() path off a jsdom
// fixture, the same pattern as path-panel.test.js — chain-graph.js's own
// canvas drawing (drawChain) is mocked out since jsdom has no real
// CanvasRenderingContext2D, so this stays a pure DOM-string assertion test.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./chain-graph.js", () => ({ drawChain: vi.fn() }));
vi.mock("../ui/autocomplete.js", () => ({ attachGeniusAutocomplete: vi.fn() }));
vi.mock("../ui/router.js", () => ({
  onSurfaceChange: vi.fn(),
  getCurrentSurface: vi.fn(() => "graph"),
  navigateToSurface: vi.fn(),
  SURFACE_GAME: "game",
  SURFACE_GRAPH: "graph",
}));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  setStartArtist, setGoalArtist, commitHop, undoLast, resetGame,
  setupConnectMode, _currentChain,
} from "./connect.js";
import { applyResult, applyLeaderboard } from "./connect-model.js";

beforeEach(() => {
  document.body.innerHTML = `
    <div id="connect-surface" hidden>
      <div class="connect-stage"><canvas id="connect-canvas"></canvas></div>
      <button id="connect-back"></button>
      <input id="connect-start-input" /><div id="connect-start-ac"></div>
      <input id="connect-goal-input" /><div id="connect-goal-ac"></div>
      <div id="connect-chain"></div>
      <p id="connect-status"></p>
      <div id="connect-result" hidden></div>
      <div id="connect-leaderboard" hidden></div>
      <input id="connect-add-input" /><div id="connect-add-ac"></div>
      <button id="connect-undo"></button>
      <button id="connect-reset"></button>
    </div>
  `;
  els.connectSurface     = document.getElementById("connect-surface");
  els.connectStage       = document.querySelector(".connect-stage");
  els.connectCanvas      = document.getElementById("connect-canvas");
  els.connectBack        = document.getElementById("connect-back");
  els.connectStartInput  = document.getElementById("connect-start-input");
  els.connectStartAc     = document.getElementById("connect-start-ac");
  els.connectGoalInput   = document.getElementById("connect-goal-input");
  els.connectGoalAc      = document.getElementById("connect-goal-ac");
  els.connectChain       = document.getElementById("connect-chain");
  els.connectStatus      = document.getElementById("connect-status");
  els.connectResult      = document.getElementById("connect-result");
  els.connectLeaderboard = document.getElementById("connect-leaderboard");
  els.connectAddInput    = document.getElementById("connect-add-input");
  els.connectAddAc       = document.getElementById("connect-add-ac");
  els.connectUndo        = document.getElementById("connect-undo");
  els.connectReset       = document.getElementById("connect-reset");

  State.connect = { startName: "", goalName: "", game: null };
  setupConnectMode();
});

describe("empty state (no endpoints chosen yet)", () => {
  it("shows the empty-chain placeholder and disables the controls", () => {
    expect(els.connectChain.innerHTML).toContain("Choose a start and a goal");
    expect(els.connectAddInput.disabled).toBe(true);
    expect(els.connectUndo.disabled).toBe(true);
    expect(els.connectReset.disabled).toBe(true);
  });
});

describe("setStartArtist / setGoalArtist", () => {
  it("builds a fresh chain once both endpoints are set, and renders the two endpoint rows", () => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    expect(_currentChain()).not.toBeNull();
    expect(els.connectChain.innerHTML).toContain("Drake");
    expect(els.connectChain.innerHTML).toContain("Adele");
    expect(els.connectStatus.textContent).toContain("reach Adele");
    expect(els.connectAddInput.disabled).toBe(false);
  });
});

describe("commitHop", () => {
  beforeEach(() => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
  });

  it("adds an intermediate hop and updates the chain list + status", () => {
    const res = commitHop("Rihanna");
    expect(res.ok).toBe(true);
    expect(els.connectChain.innerHTML).toContain("Rihanna");
    expect(els.connectStatus.textContent).toContain("1 hop");
  });

  it("clears the input field on a successful commit", () => {
    els.connectAddInput.value = "Rihanna";
    commitHop("Rihanna");
    expect(els.connectAddInput.value).toBe("");
  });

  it("completing the chain (hop == goal) marks it connected and disables further adds", () => {
    commitHop("Adele");
    expect(isCompletedStatus()).toBe(true);
    expect(els.connectStatus.textContent).toContain("Connected");
    expect(els.connectAddInput.disabled).toBe(true);
  });

  function isCompletedStatus() {
    return els.connectStatus.textContent.startsWith("Connected");
  }

  it("does nothing when there is no active chain", () => {
    State.connect.game = null;
    expect(commitHop("Rihanna")).toBeNull();
  });
});

describe("undoLast / resetGame", () => {
  beforeEach(() => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Rihanna");
  });

  it("undoLast removes the last hop and re-enables reset/undo state correctly", () => {
    undoLast();
    expect(els.connectChain.innerHTML).not.toContain("Rihanna");
    expect(els.connectUndo.disabled).toBe(true);
  });

  it("resetGame clears every hop back to the two endpoints", () => {
    resetGame();
    expect(els.connectChain.innerHTML).not.toContain("Rihanna");
    expect(els.connectReset.disabled).toBe(true);
  });
});

describe("renderResult (SF-GAME-15/03)", () => {
  beforeEach(() => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Adele");
  });

  it("stays hidden until a result has been applied", () => {
    expect(els.connectResult.hidden).toBe(true);
  });

  // commitHop() on an already-completed chain is a safe no-op (addHop's
  // "completed" branch never touches game.result) that still calls
  // render() — the same render-without-losing-state trick used to drive
  // a fresh render() pass after applying a result directly to the model,
  // the way a real submit response would arrive.
  it("renders the rejected state for an invalid submit result", () => {
    applyResult(_currentChain(), { valid: false, reason: "invalid_hop", invalid_hop_index: 0 });
    commitHop("Adele");
    expect(els.connectResult.hidden).toBe(false);
    expect(els.connectResult.innerHTML).toContain("Not a real chain");
    expect(els.connectResult.innerHTML).toContain("hop 1");
  });

  it("renders score/Elo for a revealed (valid) result", () => {
    applyResult(_currentChain(), {
      valid: true, player_len: 1, optimal_len: 1, optimal_path: [1, 2],
      score: 1000, max_score: 1000, elo_before: 1200, elo_after: 1214, elo_delta: 14,
    });
    commitHop("Adele");
    expect(els.connectResult.hidden).toBe(false);
    expect(els.connectResult.innerHTML).toContain("1000");
    expect(els.connectResult.innerHTML).toContain("1214");
  });
});

describe("renderLeaderboard (SF-GAME-17/04)", () => {
  beforeEach(() => {
    setStartArtist("Drake");
    setGoalArtist("Adele");
    commitHop("Adele");
  });

  it("stays hidden with no leaderboard applied", () => {
    expect(els.connectLeaderboard.hidden).toBe(true);
  });

  it("stays hidden for an empty entries list", () => {
    applyLeaderboard(_currentChain(), { entries: [], next_cursor: null });
    commitHop("Adele");
    expect(els.connectLeaderboard.hidden).toBe(true);
  });

  it("renders ranked rows once a non-empty leaderboard is applied", () => {
    applyLeaderboard(_currentChain(), {
      entries: [
        { user_id: 1, display_name: "Alice", score: 1000, hops: 1, ts: 100 },
        { user_id: 2, display_name: "Bob", score: 850, hops: 2, ts: 200 },
      ],
      next_cursor: null,
    });
    commitHop("Adele");
    expect(els.connectLeaderboard.hidden).toBe(false);
    expect(els.connectLeaderboard.innerHTML).toContain("Alice");
    expect(els.connectLeaderboard.innerHTML).toContain("Bob");
    expect(els.connectLeaderboard.innerHTML).toContain("Leaderboard");
  });
});
