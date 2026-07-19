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
