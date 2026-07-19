// ════════════════════════════════════════════════════════════════════════════
// ui/history.test.js — SF-WEB-02: shareable-URL full-state round-trip.
//                       serializeGraphState/parseGraphState are pure
//                       functions (State → URLSearchParams → state) so they
//                       can be tested without touching window.location.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";
import { State, GRAPH_DEFAULT_LIMIT } from "../state/state.js";
import { els } from "../dom/dom.js";
import { serializeGraphState, parseGraphState, loadArtistFromUrl } from "./history.js";

vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));

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

// [SF-WEB-61] "кнопки переключения типов связей они не проверяются по
// запросу и по-дефолту горят" — loadArtistFromUrl restores State.activeFilters
// from a shared URL's ?roles=, but used to only sync the OLD rail buttons
// (els.filterFeatured/-Producer/-Writer), removed back in SF-WEB-14 — those
// dom.js keys don't exist anymore, so the sync silently did nothing for the
// buttons that are actually visible (.role-filter-segment / canvasFilter*),
// which stayed stuck on their hardcoded-in-HTML "active" default.
describe("loadArtistFromUrl — syncs the visible role-filter buttons to the URL's roles (SF-WEB-61)", () => {
  const realLocation = window.location;

  beforeEach(() => {
    State.activeFilters = new Set(["featured", "producer", "writer"]);
    els.heroInput = document.createElement("input");
    els.canvasFilterFeatured = document.createElement("button");
    els.canvasFilterFeatured.dataset.role = "featured";
    els.canvasFilterFeatured.classList.add("active");
    els.canvasFilterProducer = document.createElement("button");
    els.canvasFilterProducer.dataset.role = "producer";
    els.canvasFilterProducer.classList.add("active");
    els.canvasFilterWriter = document.createElement("button");
    els.canvasFilterWriter.dataset.role = "writer";
    els.canvasFilterWriter.classList.add("active");
    els.heroFilterFeatured = document.createElement("button");
    els.heroFilterFeatured.dataset.role = "featured";
    els.heroFilterFeatured.classList.add("active");
  });

  it("un-lights a canvas-segment button for a role the shared URL's ?roles= omits", () => {
    delete window.location;
    window.location = new URL("https://example.test/?artist=X&roles=featured,producer");

    loadArtistFromUrl();

    expect(els.canvasFilterWriter.classList.contains("active")).toBe(false);
    expect(els.canvasFilterFeatured.classList.contains("active")).toBe(true);
    expect(els.canvasFilterProducer.classList.contains("active")).toBe(true);

    window.location = realLocation;
  });

  it("leaves the canvas-segment buttons untouched (default active) when the URL has no ?roles= at all", () => {
    delete window.location;
    window.location = new URL("https://example.test/?artist=X");

    loadArtistFromUrl();

    expect(els.canvasFilterFeatured.classList.contains("active")).toBe(true);
    expect(els.canvasFilterProducer.classList.contains("active")).toBe(true);
    expect(els.canvasFilterWriter.classList.contains("active")).toBe(true);

    window.location = realLocation;
  });
});