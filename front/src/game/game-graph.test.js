// ════════════════════════════════════════════════════════════════════════════
// game-graph.test.js — unit tests for fetchNeighbours (game-graph.js), the
// game's reuse of the Explorer's /api/v1/graph endpoint. apiFetch is mocked so
// these exercise the request URL + the graph→neighbours transform and every
// failure fallback.
// ════════════════════════════════════════════════════════════════════════════
import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/net.js", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "../api/net.js";
import { fetchNeighbours } from "./game-graph.js";

const ok = body => ({ ok: true, json: async () => body });

beforeEach(() => { apiFetch.mockReset(); });

it("returns null immediately for a null id (no request)", async () => {
  expect(await fetchNeighbours(null)).toBeNull();
  expect(apiFetch).not.toHaveBeenCalled();
});

it("requests /api/v1/graph?id= with all four roles", async () => {
  apiFetch.mockResolvedValue(ok({ seed_id: 100, seed: "Drake", nodes: [], edges: [] }));
  await fetchNeighbours(100);
  const url = apiFetch.mock.calls[0][0];
  expect(url).toContain("/api/v1/graph?id=100");
  expect(url).toContain("roles=primary%2Cproducer%2Cwriter%2Cfeatured");
});

it("maps nodes to {id,name,image}, filtering out the seed", async () => {
  apiFetch.mockResolvedValue(ok({
    seed_id: 100, seed: "Drake",
    nodes: [
      { id: 100, name: "Drake", image: "d.jpg" },
      { id: 200, name: "Rihanna", image: "r.jpg" },
      { id: 900, name: "Adele", image: null },
    ],
    edges: [],
  }));
  const res = await fetchNeighbours(100);
  expect(res.seedId).toBe(100);
  expect(res.seedName).toBe("Drake");
  expect(res.neighbours).toEqual([
    { id: 200, name: "Rihanna", image: "r.jpg" },
    { id: 900, name: "Adele", image: null },
  ]);
});

it("falls back seedId to the requested id, and name to '' when absent", async () => {
  apiFetch.mockResolvedValue(ok({ nodes: [{ id: 5, name: "X", image: null }] }));
  const res = await fetchNeighbours(42);
  expect(res.seedId).toBe(42);
  expect(res.seedName).toBe("");
  expect(res.neighbours).toEqual([{ id: 5, name: "X", image: null }]);
});

it("normalises a missing name / missing image on a node", async () => {
  apiFetch.mockResolvedValue(ok({ seed_id: 1, seed: "S", nodes: [{ id: 2 }] }));
  const res = await fetchNeighbours(1);
  expect(res.neighbours).toEqual([{ id: 2, name: "", image: null }]);
});

it("returns null on a non-ok response", async () => {
  apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => null });
  expect(await fetchNeighbours(1)).toBeNull();
});

it("returns null when the body has no nodes array", async () => {
  apiFetch.mockResolvedValue(ok({ seed_id: 1 }));
  expect(await fetchNeighbours(1)).toBeNull();
});

it("returns null when apiFetch throws", async () => {
  apiFetch.mockRejectedValue(new Error("net"));
  expect(await fetchNeighbours(1)).toBeNull();
});
