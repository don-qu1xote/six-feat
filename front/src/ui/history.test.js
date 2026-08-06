import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State, GRAPH_DEFAULT_LIMIT } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  serializeGraphState,
  parseGraphState,
  loadArtistFromUrl,
  setupChipsVisibility,
} from "./history.js";

vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));

describe("serializeGraphState / parseGraphState round-trip", () => {
  it("encodes and decodes seed artist, roles, expanded nodes and limit identically", () => {
    const original = {
      artist: "Kendrick Lamar",
      seedId: 42,
      roles: new Set(["featured", "producer"]),
      expandedIds: new Set([7, 3, 19]),
      limit: GRAPH_DEFAULT_LIMIT + 40,
    };

    const params = serializeGraphState(original);
    const decoded = parseGraphState(params.toString());

    expect(decoded.artist).toBe(original.artist);
    expect(decoded.seedId).toBe(original.seedId);
    expect(decoded.roles).toEqual(original.roles);
    expect(decoded.expandedIds).toEqual(original.expandedIds);
    expect(decoded.limit).toBe(original.limit);
  });

  it("omits the limit param when it equals the server default (compact URL)", () => {
    const params = serializeGraphState({
      artist: "Rosalía",
      seedId: 1,
      roles: new Set(),
      expandedIds: new Set(),
      limit: GRAPH_DEFAULT_LIMIT,
    });
    expect(params.has("limit")).toBe(false);
    expect(parseGraphState(params.toString()).limit).toBeNull();
  });

  it("serializes ids compactly as a sorted numeric comma-list", () => {
    const params = serializeGraphState({
      artist: "A",
      seedId: 1,
      roles: new Set(),
      expandedIds: new Set([30, 2, 100]),
      limit: null,
    });
    expect(params.get("exp")).toBe("2,30,100");
  });
});

describe("parseGraphState on invalid/missing input → defaults", () => {
  it("returns null artist/seed/limit and empty sets for an empty query string", () => {
    const decoded = parseGraphState("");
    expect(decoded).toEqual({
      artist: null,
      roles: new Set(),
      seedId: null,
      expandedIds: new Set(),
      limit: null,
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

describe("setupChipsVisibility — chips stay hidden until the search field is focused (SF-WEB-78)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    els.heroInput = document.createElement("input");
    els.chipsLabel = document.createElement("div");
    els.chipsLabel.hidden = true;
    els.chips = document.createElement("div");
    els.chips.hidden = true;
    document.body.append(els.heroInput, els.chipsLabel, els.chips);
    setupChipsVisibility();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals the chips on focus", () => {
    els.heroInput.dispatchEvent(new Event("focus"));
    expect(els.chipsLabel.hidden).toBe(false);
    expect(els.chips.hidden).toBe(false);
  });

  it("hides the chips again shortly after blur", () => {
    els.heroInput.dispatchEvent(new Event("focus"));
    els.heroInput.dispatchEvent(new Event("blur"));
    expect(els.chips.hidden).toBe(false);
    vi.advanceTimersByTime(150);
    expect(els.chipsLabel.hidden).toBe(true);
    expect(els.chips.hidden).toBe(true);
  });

  it("does not hide on blur before the click on a chip has a chance to register", () => {
    els.heroInput.dispatchEvent(new Event("focus"));
    els.heroInput.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(50);
    els.chips.dispatchEvent(new Event("click", { bubbles: true }));
    expect(els.chips.hidden).toBe(true);
    vi.advanceTimersByTime(150);
    expect(els.chips.hidden).toBe(true);
  });

  it("[SF-WEB-89] hides the chips once a query is typed, so the results dropdown below doesn't cover them", () => {
    els.heroInput.dispatchEvent(new Event("focus"));
    expect(els.chips.hidden).toBe(false);

    els.heroInput.value = "Ken";
    els.heroInput.dispatchEvent(new Event("input"));
    expect(els.chips.hidden).toBe(true);
    expect(els.chipsLabel.hidden).toBe(true);
  });

  it("[SF-WEB-89] shows the chips again once the query is cleared back to empty", () => {
    els.heroInput.dispatchEvent(new Event("focus"));
    els.heroInput.value = "Ken";
    els.heroInput.dispatchEvent(new Event("input"));
    expect(els.chips.hidden).toBe(true);

    els.heroInput.value = "";
    els.heroInput.dispatchEvent(new Event("input"));
    expect(els.chips.hidden).toBe(false);
  });
});
