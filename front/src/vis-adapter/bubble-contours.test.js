import { describe, it, expect, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { placeExpandedNodes } from "./layout.js";
import {
  setContourData,
  clearContourData,
  drawContours,
  _contourSectorCount,
  computeSectorPolygon,
  pointInPolygon,
  _convexHull,
  _padHull,
  CONTOUR_MAX_TOTAL_MEMBERS,
  toneMutedNeon,
} from "./bubble-contours.js";

function mockCtx({ withFilter = false } = {}) {
  const calls = [];
  let _composite;
  const ctx = {
    calls,
    beginPath() {
      calls.push(["beginPath"]);
    },
    closePath() {
      calls.push(["closePath"]);
    },
    moveTo(x, y) {
      calls.push(["moveTo", x, y]);
    },
    quadraticCurveTo(cx, cy, x, y) {
      calls.push(["quadraticCurveTo", cx, cy, x, y]);
    },
    fill() {
      calls.push(["fill"]);
    },
    set fillStyle(v) {
      calls.push(["fillStyle", v]);
    },
    set globalAlpha(v) {
      calls.push(["globalAlpha", v]);
    },
    get globalCompositeOperation() {
      return _composite;
    },
    set globalCompositeOperation(v) {
      _composite = v;
      calls.push(["globalCompositeOperation", v]);
    },
  };
  if (withFilter) {
    let _filter = "none";
    Object.defineProperty(ctx, "filter", {
      get: () => _filter,
      set: (v) => {
        _filter = v;
        calls.push(["filter", v]);
      },
    });
  }
  return ctx;
}

function buildTwoPoleGraph({ seedId = 1, poleA = 2, poleB = 3 } = {}) {
  const aLeaves = [200, 201, 202];
  const bLeaves = [300, 301, 302];
  const shared = 900;
  const stray = 999;
  State.graphNodes = [
    { id: seedId, isSeed: true },
    { id: poleA, isSeed: false },
    { id: poleB, isSeed: false },
    ...aLeaves.map((id) => ({ id, isSeed: false })),
    ...bLeaves.map((id) => ({ id, isSeed: false })),
    { id: shared, isSeed: false },
    { id: stray, isSeed: false },
  ];
  State.graphEdges = [
    { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
    { id: `${seedId}_${poleB}`, from: seedId, to: poleB, weight: 1 },
    { id: `${seedId}_${stray}`, from: seedId, to: stray, weight: 1 },
    ...aLeaves.map((id) => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
    ...bLeaves.map((id) => ({ id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 })),
    { id: `${poleA}_${shared}`, from: poleA, to: shared, weight: 1 },
    { id: `${poleB}_${shared}`, from: poleB, to: shared, weight: 1 },
  ];
  State.currentSeedId = seedId;
  State.expandedNodes = new Set([poleA, poleB]);
  return { seedId, poleA, poleB, aLeaves, bLeaves, shared, stray };
}

beforeEach(() => {
  State.graphNodes = [];
  State.graphEdges = [];
  State.currentSeedId = null;
  State.expandedNodes = new Set();
  State.network = null;
  State.bubbleSetsEnabled = true;
  clearContourData();
});

describe("layout.js sectorMembers (SF-WEB-58 C membership contract)", () => {
  it("puts an exclusive leaf in exactly one pole's member set", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = placeExpandedNodes({});
    expect(sectorMembers.get(g.poleA).has(g.aLeaves[0])).toBe(true);
    expect(sectorMembers.get(g.poleB).has(g.aLeaves[0])).toBe(false);
  });

  it("puts a shared/Euler leaf in BOTH owning poles' member sets", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = placeExpandedNodes({});
    expect(sectorMembers.get(g.poleA).has(g.shared)).toBe(true);
    expect(sectorMembers.get(g.poleB).has(g.shared)).toBe(true);
  });

  it("never includes a node with no relation to a pole at all", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = placeExpandedNodes({});
    expect(sectorMembers.get(g.poleA).has(g.stray)).toBe(false);
    expect(sectorMembers.get(g.poleB).has(g.stray)).toBe(false);
  });
});

describe("computeSectorPolygon / pointInPolygon geometry", () => {
  it("returns a polygon that contains every one of its own member points", () => {
    const members = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 80 },
      { x: 30, y: 20 },
    ];
    const poly = computeSectorPolygon(members);
    for (const p of members) expect(pointInPolygon(p, poly)).toBe(true);
  });

  it("does not contain a point far outside the member cluster", () => {
    const members = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 10, y: 15 },
    ];
    const poly = computeSectorPolygon(members);
    expect(pointInPolygon({ x: 5000, y: 5000 }, poly)).toBe(false);
  });

  it("returns [] for a single point (nothing to enclose)", () => {
    expect(computeSectorPolygon([{ x: 0, y: 0 }])).toEqual([]);
  });

  it("handles collinear members (degenerate hull) without throwing, still containing them", () => {
    const members = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    const poly = computeSectorPolygon(members);
    expect(() => poly).not.toThrow();
    for (const p of members) expect(pointInPolygon(p, poly)).toBe(true);
  });

  it("_padHull strictly enlarges a triangle so it still contains the original vertices", () => {
    const hull = _convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 8 },
    ]);
    const padded = _padHull(hull, 20);
    for (const p of hull) expect(pointInPolygon(p, padded)).toBe(true);
  });
});

describe("end-to-end: a shared leaf sits inside ≥2 sector polygons, a stray node in none (the ticket's own test)", () => {
  it("shared leaf inside both poles' polygons; stray node outside both", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;

    const polyFor = (poleId) =>
      computeSectorPolygon(
        [...sectorMembers.get(poleId)].map((id) => positions[id]).filter(Boolean),
      );
    const polyA = polyFor(g.poleA);
    const polyB = polyFor(g.poleB);

    const sharedPos = positions[g.shared];
    expect(pointInPolygon(sharedPos, polyA)).toBe(true);
    expect(pointInPolygon(sharedPos, polyB)).toBe(true);

    const strayPos = positions[g.stray];
    if (strayPos) {
      expect(pointInPolygon(strayPos, polyA)).toBe(false);
      expect(pointInPolygon(strayPos, polyB)).toBe(false);
    }

    const exclusiveAPos = positions[g.aLeaves[0]];
    expect(pointInPolygon(exclusiveAPos, polyB)).toBe(false);
  });
});

describe("setContourData / drawContours", () => {
  it("stores one entry per hub (poles AND the seed), colored from that hub's own role", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    expect(_contourSectorCount()).toBe(3);
    void g;
  });

  it("clearContourData empties the cache", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    clearContourData();
    expect(_contourSectorCount()).toBe(0);
    void g;
  });

  it("draws a fill per sector with ≥2 members, under nodes (beforeDrawing — no assumption needed here beyond: it fills, doesn't stroke/clip)", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx = mockCtx();
    drawContours(ctx);
    const fillCalls = ctx.calls.filter((c) => c[0] === "fill").length;
    expect(fillCalls).toBe(3);
  });

  it("skips a sector with fewer than 2 members (nothing meaningful to enclose)", () => {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false },
    ];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, weight: 1 }];
    State.currentSeedId = 1;
    State.expandedNodes = new Set([2]);
    const { sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    State.network = { getPositions: () => ({ 1: { x: 0, y: 0 }, 2: { x: 100, y: 0 } }) };

    const ctx = mockCtx();
    drawContours(ctx);
    expect(ctx.calls.filter((c) => c[0] === "fill").length).toBe(0);
  });

  it("draws even a large member count now — the old LOD auto-hide is gone, only the manual toggle gates drawing", () => {
    const seedId = 1,
      poleId = 2;
    const leaves = Array.from({ length: CONTOUR_MAX_TOTAL_MEMBERS + 5 }, (_, i) => 100 + i);
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleId, isSeed: false },
      ...leaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleId}`, from: seedId, to: poleId, weight: 1 },
      ...leaves.map((id) => ({ id: `${poleId}_${id}`, from: poleId, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleId]);
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx = mockCtx();
    drawContours(ctx);
    expect(ctx.calls.filter((c) => c[0] === "fill").length).toBeGreaterThan(0);
  });

  it("caches the computed polygon and only recomputes when a member's position actually moves", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx1 = mockCtx();
    drawContours(ctx1);
    const ctx2 = mockCtx();
    drawContours(ctx2);
    const trace = (calls) => calls.filter((c) => c[0] === "quadraticCurveTo" || c[0] === "moveTo");
    expect(trace(ctx1.calls)).toEqual(trace(ctx2.calls));
  });
});

describe("toneMutedNeon (SF-WEB-59)", () => {
  it("keeps a moderate color's hue essentially unchanged", () => {
    const toned = toneMutedNeon("#4080c0");
    expect(toned.toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("brightens a near-black color into the visible muted-neon band instead of staying invisible", () => {
    const toned = toneMutedNeon("#0a0a0a");
    const brightness =
      parseInt(toned.slice(1, 3), 16) +
      parseInt(toned.slice(3, 5), 16) +
      parseInt(toned.slice(5, 7), 16);
    expect(brightness).toBeGreaterThan(100);
  });

  it("lifts a dark pure-hue color's brightness up into the palette's own range, without shifting its hue", () => {
    const toned = toneMutedNeon("#800000");
    const r = parseInt(toned.slice(1, 3), 16);
    const g = parseInt(toned.slice(3, 5), 16);
    const b = parseInt(toned.slice(5, 7), 16);
    expect(r).toBeGreaterThan(128);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it("is deterministic — same input always gives the same output", () => {
    expect(toneMutedNeon("#7799bb")).toBe(toneMutedNeon("#7799bb"));
  });
});

describe("setContourData — photo color vs role-hue fallback (SF-WEB-59)", () => {
  // [SF-API-20] Цвет фотографии больше не выбирается в браузере: сервер
  // считает его один раз (image_proxy_handler.cpp) и присылает вместе с узлом.
  // Поэтому подменять Image и canvas здесь нечего — сценарий задаётся полем
  // узла, а «цвет ещё не посчитан» это просто его отсутствие.
  it("uses the hub's dominant colour from the node data (tone-mapped)", () => {
    const g = buildTwoPoleGraph();
    State.graphNodes.find((n) => n.id === g.poleA).dominantColor = "#c8320a";

    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx = mockCtx();
    drawContours(ctx);
    const fillStyles = ctx.calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
    expect(fillStyles).toContain(toneMutedNeon("#c8320a"));
  });

  it("falls back to the hub's role hue when no photo color has been sampled", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const { targets } = placeExpandedNodes({});
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx = mockCtx();
    drawContours(ctx);
    const fillStyles = ctx.calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
    expect(fillStyles.length).toBeGreaterThan(0);
  });
});

describe("drawContours — additive blend + soft blur (SF-WEB-59)", () => {
  it("sets globalCompositeOperation to 'lighter' while filling, then restores it", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx = mockCtx();
    ctx.globalCompositeOperation = "source-over";
    ctx.calls.length = 0;
    drawContours(ctx);

    const ops = ctx.calls.filter((c) => c[0] === "globalCompositeOperation").map((c) => c[1]);
    expect(ops[0]).toBe("lighter");
    expect(ops[ops.length - 1]).toBe("source-over");
  });

  it("applies a blur filter while the context supports one, restoring it afterward", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx = mockCtx({ withFilter: true });
    drawContours(ctx);

    const filterCalls = ctx.calls.filter((c) => c[0] === "filter").map((c) => c[1]);
    expect(filterCalls.some((v) => /^blur\(\d+px\)$/.test(v))).toBe(true);
    expect(ctx.filter).toBe("none");
  });

  it("never throws when the context has no 'filter' support (e.g. this repo's other mock ctx style)", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    const ctx = mockCtx();
    expect(() => drawContours(ctx)).not.toThrow();
  });
});

describe("drawContours — manual toggle (SF-WEB-61)", () => {
  it("draws nothing when State.bubbleSetsEnabled is false, even with valid sector data", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    State.bubbleSetsEnabled = false;
    const ctx = mockCtx();
    drawContours(ctx);
    expect(ctx.calls.filter((c) => c[0] === "fill").length).toBe(0);
  });

  it("draws once State.bubbleSetsEnabled is switched on", () => {
    const g = buildTwoPoleGraph();
    const { targets, sectorMembers } = placeExpandedNodes({});
    setContourData(sectorMembers);
    const positions = { [g.seedId]: { x: 0, y: 0 } };
    for (const [id, p] of targets) positions[id] = p;
    State.network = { getPositions: () => positions };

    State.bubbleSetsEnabled = true;
    const ctx = mockCtx();
    drawContours(ctx);
    expect(ctx.calls.filter((c) => c[0] === "fill").length).toBeGreaterThan(0);
  });
});

describe("toneMutedNeon — colour space round trip", () => {
  const isHex = (v) => /^#[0-9a-f]{6}$/.test(v);

  it("returns a well-formed hex colour", () => {
    expect(isHex(toneMutedNeon("#5ee6c5"))).toBe(true);
  });

  it("lifts a dark, dull colour into the neon band", () => {
    const toned = toneMutedNeon("#101820");
    expect(isHex(toned)).toBe(true);
    expect(toned).not.toBe("#101820");
  });

  it("pulls an over-bright colour back down", () => {
    const toned = toneMutedNeon("#ffffff");
    expect(isHex(toned)).toBe(true);
    expect(toned).not.toBe("#ffffff");
  });

  it("handles pure black and pure white without producing NaN", () => {
    for (const hex of ["#000000", "#ffffff"]) {
      expect(isHex(toneMutedNeon(hex))).toBe(true);
    }
  });

  it("handles each primary, exercising every hue branch", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff"]) {
      expect(isHex(toneMutedNeon(hex))).toBe(true);
    }
  });

  it("handles a blue-dominant colour where green is below blue", () => {
    expect(isHex(toneMutedNeon("#3300ff"))).toBe(true);
  });

  it("is stable — toning an already-toned colour changes nothing more", () => {
    const once = toneMutedNeon("#5ee6c5");
    expect(toneMutedNeon(once)).toBe(once);
  });

  it("keeps a grey achromatic rather than inventing a hue", () => {
    const toned = toneMutedNeon("#808080");
    expect(isHex(toned)).toBe(true);
  });
});
