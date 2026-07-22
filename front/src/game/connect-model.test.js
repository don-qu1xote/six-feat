// ════════════════════════════════════════════════════════════════════════════
// game/connect-model.test.js — [design: ветвящийся веб] the pure Connect-mode
// branching-web model.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConnectChain, chainNodes, hopCount, isComplete, webSize,
  webNodes, webEdges, winningPath, focusName, setFocus,
  addHop, undoHop, resetChain, setChallengeId,
  applyResult, clearResult, resultView,
  applyLeaderboard, clearLeaderboard, leaderboardView,
  giveUp, pathRevealed, elapsedMs,
} from "./connect-model.js";

describe("createConnectChain", () => {
  it("starts as a lone start node, focused, with the goal not yet in the web", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(webNodes(g)).toEqual(["Drake"]);
    expect(chainNodes(g)).toEqual(["Drake"]);   // the current line is just start→focus
    expect(focusName(g)).toBe("Drake");
    expect(hopCount(g)).toBe(0);
    expect(webSize(g)).toBe(0);
    expect(winningPath(g)).toBeNull();
    expect(isComplete(g)).toBe(false);
    expect(g.challengeId).toBeNull();
  });

  it("normalizes endpoint whitespace on creation", () => {
    const g = createConnectChain("  Drake  ", "A  d  ele");
    expect(g.start).toBe("Drake");
    expect(g.goal).toBe("A d ele");
  });
});

describe("addHop (attaches to the focus, focus follows)", () => {
  it("appends under the focus and moves the focus onto the new node (linear typing)", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(addHop(g, "Rihanna")).toEqual({ ok: true, completed: false });
    expect(focusName(g)).toBe("Rihanna");
    expect(addHop(g, "Paul Epworth")).toEqual({ ok: true, completed: false });
    expect(chainNodes(g)).toEqual(["Drake", "Rihanna", "Paul Epworth"]);
    expect(hopCount(g)).toBe(2);
    expect(webSize(g)).toBe(2);
  });

  it("rejects an empty/whitespace name", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(addHop(g, "   ")).toEqual({ ok: false, reason: "empty" });
    expect(webSize(g)).toBe(0);
  });

  it("rejects re-adding the focused node itself", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    expect(addHop(g, "Rihanna")).toEqual({ ok: false, reason: "duplicate" });
  });

  it("rejects an artist already anywhere in the web (re-focus to branch instead)", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "21 Savage");
    expect(addHop(g, "Rihanna")).toEqual({ ok: false, reason: "exists" });
  });

  it("naming the goal joins it to the web under the focus and completes", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    expect(addHop(g, "Adele")).toEqual({ ok: true, completed: true });
    expect(isComplete(g)).toBe(true);
    expect(winningPath(g)).toEqual(["Drake", "Rihanna", "Adele"]);
    expect(chainNodes(g)).toEqual(["Drake", "Rihanna", "Adele"]); // focus followed to the goal
  });

  it("is case-insensitive for duplicate and goal checks", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    expect(addHop(g, "RIHANNA")).toEqual({ ok: false, reason: "duplicate" });
    expect(addHop(g, "adele")).toEqual({ ok: true, completed: true });
  });

  it("is a no-op once completed or given up", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Adele");
    expect(addHop(g, "Rihanna")).toEqual({ ok: false, reason: "over" });

    const g2 = createConnectChain("Drake", "Adele");
    addHop(g2, "Rihanna"); giveUp(g2);
    expect(addHop(g2, "21 Savage")).toEqual({ ok: false, reason: "over" });
  });
});

describe("[design: ветвящийся веб] branching via setFocus", () => {
  it("re-focusing an earlier node grows a SECOND branch from it", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");        // Drake→Rihanna (focus Rihanna)
    addHop(g, "Calvin Harris");  // Rihanna→Calvin (focus Calvin)
    expect(setFocus(g, "Drake").ok).toBe(true);
    addHop(g, "Future");         // NEW branch: Drake→Future (focus Future)
    expect(new Set(webNodes(g))).toEqual(new Set(["Drake", "Rihanna", "Calvin Harris", "Future"]));
    expect(chainNodes(g)).toEqual(["Drake", "Future"]); // current line follows the new branch
    expect(webSize(g)).toBe(3);
  });

  it("winningPath is the branch that actually reached the goal, not the other one", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "Dead End");          // Drake→Rihanna→Dead End (a losing branch)
    setFocus(g, "Drake");
    addHop(g, "Paul Epworth");      // Drake→Paul Epworth
    addHop(g, "Adele");             // Paul Epworth→Adele — wins on THIS branch
    expect(winningPath(g)).toEqual(["Drake", "Paul Epworth", "Adele"]);
  });

  it("setFocus is a no-op for an unknown node or once the round is over", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(setFocus(g, "Nobody").ok).toBe(false);
    addHop(g, "Adele");
    expect(setFocus(g, "Drake").ok).toBe(false);
  });

  it("webEdges lists every parent→child link", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    setFocus(g, "Drake");
    addHop(g, "Future");
    expect(webEdges(g)).toEqual([
      { from: "Drake", to: "Rihanna" },
      { from: "Drake", to: "Future" },
    ]);
  });
});

describe("undoHop", () => {
  it("removes the most-recently-added node and focuses its parent", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "21 Savage");
    expect(undoHop(g)).toEqual({ undone: "21 Savage" });
    expect(webNodes(g)).toEqual(["Drake", "Rihanna"]);
    expect(focusName(g)).toBe("Rihanna");
  });

  it("re-opens a completed web on first undo (drops the goal, focuses its parent)", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "Adele");
    expect(isComplete(g)).toBe(true);
    expect(undoHop(g)).toEqual({ undone: "goal" });
    expect(isComplete(g)).toBe(false);
    expect(webNodes(g)).toEqual(["Drake", "Rihanna"]);
    expect(focusName(g)).toBe("Rihanna");
  });

  it("undoing a completed web resumes the clock", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Adele");
    expect(g.finishedAt).not.toBeNull();
    undoHop(g);
    expect(g.finishedAt).toBeNull();
  });

  it("returns null when there's nothing to undo", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(undoHop(g)).toEqual({ undone: null });
  });
});

describe("resetChain", () => {
  it("clears the whole web back to the start, keeps the endpoints and challengeId", () => {
    const g = createConnectChain("Drake", "Adele");
    setChallengeId(g, 42);
    addHop(g, "Rihanna");
    addHop(g, "Adele");
    applyResult(g, { valid: true, player_len: 1, optimal_len: 1, optimal_path: [], score: 10, max_score: 10, elo_before: 1200, elo_after: 1210, elo_delta: 10 });
    resetChain(g);
    expect(g.start).toBe("Drake");
    expect(g.goal).toBe("Adele");
    expect(g.challengeId).toBe(42);
    expect(webNodes(g)).toEqual(["Drake"]);
    expect(focusName(g)).toBe("Drake");
    expect(isComplete(g)).toBe(false);
    expect(resultView(g)).toBeNull();
  });
});

describe("giveUp / pathRevealed", () => {
  it("is not revealed on a fresh chain", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(pathRevealed(g)).toBe(false);
  });

  it("reaching the goal reveals the path without calling giveUp", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Adele");
    expect(pathRevealed(g)).toBe(true);
  });

  it("giveUp reveals an incomplete chain", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    giveUp(g);
    expect(g.gaveUp).toBe(true);
    expect(pathRevealed(g)).toBe(true);
  });

  it("giveUp is a no-op once the chain is already complete", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Adele");
    giveUp(g);
    expect(g.gaveUp).toBe(false);
  });
});

describe("timer (elapsedMs / startedAt / finishedAt)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("starts at 0 elapsed and unfrozen on creation", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(g.finishedAt).toBeNull();
    expect(elapsedMs(g)).toBe(0);
  });

  it("keeps advancing with the clock while the round is open", () => {
    const g = createConnectChain("Drake", "Adele");
    vi.setSystemTime(new Date("2026-01-01T00:00:07.000Z"));
    expect(elapsedMs(g)).toBe(7000);
  });

  it("freezes at the moment the goal is reached", () => {
    const g = createConnectChain("Drake", "Adele");
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    addHop(g, "Adele");
    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    expect(elapsedMs(g)).toBe(5000);
  });

  it("freezes at the moment the player gives up", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    vi.setSystemTime(new Date("2026-01-01T00:00:12.000Z"));
    giveUp(g);
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    expect(elapsedMs(g)).toBe(12000);
  });
});

describe("result (SF-GAME-15/03)", () => {
  it("stays null before applyResult", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(resultView(g)).toBeNull();
  });

  it("normalizes a rejected verdict", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, { valid: false, reason: "invalid_hop", invalid_hop_index: 1 });
    expect(resultView(g)).toEqual({ revealed: false, reason: "invalid_hop", invalidHopIndex: 1 });
  });

  it("normalizes a revealed verdict, camelCasing the wire fields", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, {
      valid: true, player_len: 2, optimal_len: 1, optimal_path: [1, 2],
      score: 700, max_score: 1000, elo_before: 1200, elo_after: 1214, elo_delta: 14,
    });
    expect(resultView(g)).toEqual({
      revealed: true, playerLen: 2, optimalLen: 1, optimalPath: [1, 2],
      score: 700, maxScore: 1000, eloBefore: 1200, eloAfter: 1214, eloDelta: 14,
    });
  });

  it("clearResult resets to null", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, { valid: false, reason: "endpoint_mismatch" });
    clearResult(g);
    expect(resultView(g)).toBeNull();
  });

  it("ignores a malformed response", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, null);
    expect(resultView(g)).toBeNull();
  });
});

describe("leaderboard (SF-GAME-17/04)", () => {
  it("stays null before applyLeaderboard", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(leaderboardView(g)).toBeNull();
  });

  it("normalizes entries", () => {
    const g = createConnectChain("Drake", "Adele");
    applyLeaderboard(g, {
      entries: [{ user_id: 1, display_name: "Alice", score: 900, hops: 2, ts: 100 }],
      next_cursor: "abc",
    });
    expect(leaderboardView(g)).toEqual({
      entries: [{ userId: 1, displayName: "Alice", score: 900, hops: 2, ts: 100 }],
      nextCursor: "abc",
    });
  });

  it("ignores a malformed response", () => {
    const g = createConnectChain("Drake", "Adele");
    applyLeaderboard(g, { entries: "not-an-array" });
    expect(leaderboardView(g)).toBeNull();
  });

  it("clearLeaderboard resets to null", () => {
    const g = createConnectChain("Drake", "Adele");
    applyLeaderboard(g, { entries: [], next_cursor: null });
    clearLeaderboard(g);
    expect(leaderboardView(g)).toBeNull();
  });
});
