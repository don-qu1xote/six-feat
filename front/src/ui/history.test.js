// ════════════════════════════════════════════════════════════════════════════
// ui/history.test.js — SF-WEB-02: shareable-URL full-state round-trip.
//                       serializeGraphState/parseGraphState are pure
//                       functions (State → URLSearchParams → state) so they
//                       can be tested without touching window.location.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { GRAPH_DEFAULT_LIMIT } from "../state/state.js";
import { serializeGraphState, parseGraphState } from "./history.js";

describe("serializeGraphState / parseGraphState round-trip", () => {
  it("encodes and decodes seed artist, roles, expanded nodes and limit identically", () => {
    const original = {
      artist:      "Kendrick Lamar",
      seedId:      42,
      roles:       new Set(["featured", "producer"]),
      expandedIds: new Set([7, 3, 19]),
      limit:       GRAPH_DEFAULT_LIMIT + 40,
    };

    const params  = serializeGraphState(original);
    const decoded = parseGraphState(params.toString());

    expect(decoded.artist).toBe(original.artist);
    expect(decoded.seedId).toBe(original.seedId);
    expect(decoded.roles).toEqual(original.roles);
    expect(decoded.expandedIds).toEqual(original.expandedIds);
    expect(decoded.limit).toBe(original.limit);
  });

  it("omits the limit param when it equals the server default (compact URL)", () => {
    const params = serializeGraphState({
      artist: "Rosalía", seedId: 1, roles: new Set(), expandedIds: new Set(),
      limit: GRAPH_DEFAULT_LIMIT,
    });
    expect(params.has("limit")).toBe(false);
    expect(parseGraphState(params.toString()).limit).toBeNull();
  });

  it("serializes ids compactly as a sorted numeric comma-list", () => {
    const params = serializeGraphState({
      artist: "A", seedId: 1, roles: new Set(), expandedIds: new Set([30, 2, 100]),
      limit: null,
    });
    expect(params.get("exp")).toBe("2,30,100");
  });
});

describe("parseGraphState on invalid/missing input → defaults", () => {
  it("returns null artist/seed/limit and empty sets for an empty query string", () => {
    const decoded = parseGraphState("");
    expect(decoded).toEqual({
      artist: null, roles: new Set(), seedId: null, expandedIds: new Set(), limit: null,
    });
  });

  it("ignores garbage seed/limit/exp values instead of throwing", () => {
    const decoded = parseGraphState("?artist=X&seed=not-a-number&limit=NaN&exp=foo,,12,bar");
    expect(decoded.artist).toBe("X");
    expect(decoded.seedId).toBeNull();
    expect(decoded.limit).toBeNull();
    expect(decoded.expandedIds).toEqual(new Set([12]));
  });

  it("tolerates a completely unrelated query string", () => {
    const decoded = parseGraphState("?utm_source=twitter&foo=bar");
    expect(decoded.artist).toBeNull();
    expect(decoded.roles.size).toBe(0);
    expect(decoded.expandedIds.size).toBe(0);
  });
});