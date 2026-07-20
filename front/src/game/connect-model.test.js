// ════════════════════════════════════════════════════════════════════════════
// game/connect-model.test.js — [SF-GAME-01] the pure Connect-mode chain model.
// No DOM, no network, no game-service — the whole point of connect-model.js
// being framework-free (see its header) is that the "build a chain" mechanic
// is testable exactly like this.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import {
  createConnectChain, chainNodes, hopCount, isComplete,
  addHop, undoHop, resetChain,
  applyValidation, clearValidation, hopStatuses,
  applyResult, clearResult, resultView,
} from "./connect-model.js";

describe("createConnectChain / chainNodes", () => {
  it("starts with the two fixed endpoints and nothing between them", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(chainNodes(g)).toEqual(["Drake", "Adele"]);
    expect(hopCount(g)).toBe(0);
    expect(isComplete(g)).toBe(false);
  });

  it("normalizes endpoint whitespace on creation", () => {
    const g = createConnectChain("  Drake  ", "A  d  ele");
    expect(g.start).toBe("Drake");
    expect(g.goal).toBe("A d ele");
  });
});

describe("addHop", () => {
  it("appends intermediates in order between start and goal", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(addHop(g, "Rihanna")).toEqual({ ok: true, completed: false });
    expect(addHop(g, "Paul Epworth")).toEqual({ ok: true, completed: false });
    expect(chainNodes(g)).toEqual(["Drake", "Rihanna", "Paul Epworth", "Adele"]);
    expect(hopCount(g)).toBe(2);
  });

  it("rejects an empty or whitespace-only hop", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(addHop(g, "   ")).toEqual({ ok: false, reason: "empty" });
    expect(hopCount(g)).toBe(0);
  });

  it("rejects a hop identical to the current tail (no self-loop), case-insensitively", () => {
    const g = createConnectChain("Drake", "Adele");
    // tail is the start when there are no hops yet
    expect(addHop(g, "drake")).toEqual({ ok: false, reason: "duplicate" });
    addHop(g, "Rihanna");
    // tail is now the last hop
    expect(addHop(g, "RIHANNA")).toEqual({ ok: false, reason: "duplicate" });
    expect(hopCount(g)).toBe(1);
  });

  it("marks the chain completed when the goal is added, without storing it as a hop", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    expect(addHop(g, "Adele")).toEqual({ ok: true, completed: true });
    expect(isComplete(g)).toBe(true);
    expect(hopCount(g)).toBe(1); // goal did NOT become a hop
    expect(chainNodes(g)).toEqual(["Drake", "Rihanna", "Adele"]); // goal shown once
  });

  it("allows a direct start→goal connection with no intermediates", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(addHop(g, "Adele")).toEqual({ ok: true, completed: true });
    expect(chainNodes(g)).toEqual(["Drake", "Adele"]);
  });

  it("is a no-op once completed until undone", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Adele");
    expect(addHop(g, "Rihanna")).toEqual({ ok: false, reason: "completed" });
  });
});

describe("undoHop", () => {
  it("pops the last hop", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "Paul Epworth");
    expect(undoHop(g)).toEqual({ undone: "Paul Epworth" });
    expect(chainNodes(g)).toEqual(["Drake", "Rihanna", "Adele"]);
  });

  it("re-opens a completed chain on the first undo without dropping a hop", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "Adele"); // completes
    expect(undoHop(g)).toEqual({ undone: "goal" });
    expect(isComplete(g)).toBe(false);
    expect(hopCount(g)).toBe(1); // hop kept
    // now a second undo pops the real hop
    expect(undoHop(g)).toEqual({ undone: "Rihanna" });
  });

  it("returns null when there is nothing to undo", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(undoHop(g)).toEqual({ undone: null });
  });
});

describe("resetChain", () => {
  it("clears all hops and completion but keeps the endpoints", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "Adele");
    resetChain(g);
    expect(hopCount(g)).toBe(0);
    expect(isComplete(g)).toBe(false);
    expect(chainNodes(g)).toEqual(["Drake", "Adele"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SF-GAME-14/02] Server validation rendering — applyValidation/hopStatuses
// are driven entirely off a hand-built mock response shaped exactly like
// POST /api/v1/game/validate's real 200 body (see
// services/game/validate_handler.cpp). No network call, no Genius, no
// game-service — the whole point, same as the rest of this file.
// ─────────────────────────────────────────────────────────────────────────────

describe("hopStatuses (before any validation)", () => {
  it("has exactly one (unknown) transition for a bare start→goal chain", () => {
    const g = createConnectChain("Drake", "Adele");
    expect(hopStatuses(g)).toEqual(["unknown"]);
  });

  it("is all 'unknown' once hops exist but nothing has been checked yet", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "Paul Epworth");
    // 4 nodes → 3 transitions: Drake→Rihanna, Rihanna→Paul Epworth, Paul Epworth→Adele
    expect(hopStatuses(g)).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("applyValidation / hopStatuses", () => {
  it("marks every transition valid on a {valid: true} server response", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: true });
    expect(hopStatuses(g)).toEqual(["valid", "valid"]);
  });

  it("marks the first bad transition invalid and leaves the rest unknown", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    addHop(g, "Paul Epworth");
    // 3 transitions (indices 0,1,2): the server only ever checks up through
    // the first break, so index 2 (Paul Epworth→Adele) was never examined.
    applyValidation(g, { valid: false, reason: "invalid_hop", invalid_hop_index: 1 });
    expect(hopStatuses(g)).toEqual(["valid", "invalid", "unknown"]);
  });

  it("treats invalid_hop_index 0 as the very first transition, not 'no index'", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: false, reason: "invalid_hop", invalid_hop_index: 0 });
    expect(hopStatuses(g)).toEqual(["invalid", "unknown"]);
  });

  it("falls back to all-unknown on an endpoint_mismatch response (no hop was checked)", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: false, reason: "endpoint_mismatch" });
    expect(hopStatuses(g)).toEqual(["unknown", "unknown"]);
  });

  it("ignores a malformed/garbage response instead of throwing", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, null);
    expect(hopStatuses(g)).toEqual(["unknown", "unknown"]);
    applyValidation(g, "not an object");
    expect(hopStatuses(g)).toEqual(["unknown", "unknown"]);
  });

  it("clearValidation resets to the unchecked state", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: true });
    clearValidation(g);
    expect(hopStatuses(g)).toEqual(["unknown", "unknown"]);
  });
});

describe("validation is invalidated by any chain edit", () => {
  it("addHop (on success) clears a prior validation result", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: true });
    addHop(g, "Paul Epworth");
    expect(hopStatuses(g)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("addHop rejected (duplicate/empty) does NOT clear a prior validation result", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: true });
    expect(addHop(g, "")).toEqual({ ok: false, reason: "empty" });
    expect(hopStatuses(g)).toEqual(["valid", "valid"]);
  });

  it("undoHop clears a prior validation result", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: true });
    undoHop(g);
    // back to a bare start→goal chain: one (now unchecked) transition again
    expect(hopStatuses(g)).toEqual(["unknown"]);
  });

  it("resetChain clears a prior validation result", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyValidation(g, { valid: true });
    resetChain(g);
    expect(hopStatuses(g)).toEqual(["unknown"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SF-GAME-15/03] Result screen — applyResult/resultView are driven entirely
// off a hand-built mock response shaped exactly like POST
// /api/v1/game/submit's real 200 body (see services/game/submit_handler.cpp).
// No network, no game-service, no Elo math re-implemented here — the whole
// point, same as the rest of this file.
// ─────────────────────────────────────────────────────────────────────────────

describe("resultView (before any submit)", () => {
  it("is null — nothing to show, and specifically nothing about the ideal", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    expect(resultView(g)).toBeNull();
  });
});

describe("applyResult / resultView — the ideal is revealed only on a valid result", () => {
  it("reveals the player chain, the ideal, and the score/Elo breakdown", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyResult(g, {
      valid: true,
      player_len: 2,
      optimal_len: 1,
      optimal_path: [1, 2],
      score: 900,
      max_score: 1000,
      elo_before: 1200,
      elo_after: 1212,
      elo_delta: 12,
    });
    const view = resultView(g);
    expect(view).toEqual({
      revealed: true,
      playerChain: ["Drake", "Rihanna", "Adele"],
      playerLen: 2,
      optimalPath: [1, 2],
      optimalLen: 1,
      score: 900,
      maxScore: 1000,
      eloBefore: 1200,
      eloAfter: 1212,
      eloDelta: 12,
    });
  });

  it("does NOT reveal the ideal on a rejected (invalid) submit response", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyResult(g, { valid: false, reason: "invalid_hop", invalid_hop_index: 0 });
    const view = resultView(g);
    expect(view).toEqual({
      revealed: false,
      reason: "invalid_hop",
      invalidHopIndex: 0,
    });
    expect(view.optimalPath).toBeUndefined();
  });

  it("falls back to reason 'unknown' on a rejection with no reason field", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, { valid: false });
    expect(resultView(g)).toEqual({ revealed: false, reason: "unknown", invalidHopIndex: null });
  });

  it("ignores a malformed/garbage response instead of throwing", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, null);
    expect(resultView(g)).toBeNull();
    applyResult(g, "not an object");
    expect(resultView(g)).toBeNull();
  });

  it("clearResult resets to the unsubmitted state", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, { valid: true, player_len: 1, optimal_len: 1, optimal_path: [1, 2], score: 1000, max_score: 1000, elo_before: 1200, elo_after: 1214, elo_delta: 14 });
    clearResult(g);
    expect(resultView(g)).toBeNull();
  });
});

describe("result is invalidated by any chain edit, same as validation", () => {
  const mockResult = { valid: true, player_len: 1, optimal_len: 1, optimal_path: [1, 2], score: 1000, max_score: 1000, elo_before: 1200, elo_after: 1214, elo_delta: 14 };

  it("addHop (on success) clears a prior result", () => {
    const g = createConnectChain("Drake", "Adele");
    applyResult(g, mockResult);
    addHop(g, "Rihanna");
    expect(resultView(g)).toBeNull();
  });

  it("undoHop clears a prior result", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyResult(g, mockResult);
    undoHop(g);
    expect(resultView(g)).toBeNull();
  });

  it("resetChain clears a prior result", () => {
    const g = createConnectChain("Drake", "Adele");
    addHop(g, "Rihanna");
    applyResult(g, mockResult);
    resetChain(g);
    expect(resultView(g)).toBeNull();
  });
});
