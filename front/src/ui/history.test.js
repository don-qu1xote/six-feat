import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State, GRAPH_DEFAULT_LIMIT, MAX_HISTORY } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  serializeGraphState,
  parseGraphState,
  loadArtistFromUrl,
  setupChipsVisibility,
  showChipsIfHistory,
  loadHistory,
  saveHistory,
  pushHistory,
  renderChips,
  updateShareableUrl,
  copyShareableLink,
} from "./history.js";

vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));

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

describe("showChipsIfHistory (SF-WEB-93)", () => {
  beforeEach(() => {
    els.chipsLabel = document.createElement("div");
    els.chipsLabel.hidden = true;
    els.chips = document.createElement("div");
    els.chips.hidden = true;
    document.body.append(els.chipsLabel, els.chips);
  });

  it("reveals the chips immediately when there's real search history", () => {
    State.history = ["Kendrick Lamar"];
    showChipsIfHistory();
    expect(els.chipsLabel.hidden).toBe(false);
    expect(els.chips.hidden).toBe(false);
  });

  it("leaves the chips hidden for a first-time visitor with no history", () => {
    State.history = [];
    showChipsIfHistory();
    expect(els.chips.hidden).toBe(true);
  });
});

describe("loadHistory / saveHistory / pushHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `<div id="chips-label"></div><div id="chips"></div>`;
    els.chips = document.getElementById("chips");
    els.chipsLabel = document.getElementById("chips-label");
    State.history = [];
  });

  it("starts empty when nothing was ever stored", () => {
    loadHistory();
    expect(State.history).toEqual([]);
  });

  it("reads back what was saved", () => {
    State.history = ["Drake", "Future"];
    saveHistory();
    State.history = [];

    loadHistory();

    expect(State.history).toEqual(["Drake", "Future"]);
  });

  it("ignores a corrupted stored value instead of crashing on load", () => {
    localStorage.setItem("feat-atlas-history", "{not json");
    loadHistory();
    expect(State.history).toEqual([]);
  });

  it("ignores a stored value of the wrong shape", () => {
    localStorage.setItem("feat-atlas-history", '{"nope":1}');
    loadHistory();
    expect(State.history).toEqual([]);
  });

  it("survives storage being unavailable when saving", () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };

    expect(() => saveHistory()).not.toThrow();

    Storage.prototype.setItem = setItem;
  });

  it("puts the newest search first", () => {
    pushHistory("Drake");
    pushHistory("Future");

    expect(State.history).toEqual(["Future", "Drake"]);
  });

  it("moves a repeat search back to the front instead of duplicating it", () => {
    pushHistory("Drake");
    pushHistory("Future");
    pushHistory("Drake");

    expect(State.history).toEqual(["Drake", "Future"]);
  });

  it("caps the stored history", () => {
    for (let i = 0; i < MAX_HISTORY + 5; i++) pushHistory(`Artist ${i}`);

    expect(State.history).toHaveLength(MAX_HISTORY);
  });

  it("persists and re-renders the chips on every push", () => {
    pushHistory("Drake");

    expect(JSON.parse(localStorage.getItem("feat-atlas-history"))).toEqual(["Drake"]);
    expect(els.chips.querySelectorAll(".chip")).toHaveLength(1);
  });
});

describe("renderChips", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="chips-label"></div><div id="chips"></div>`;
    els.chips = document.getElementById("chips");
    els.chipsLabel = document.getElementById("chips-label");
    State.history = [];
    State.lang = "en";
  });

  it("offers curated examples to a first-time visitor", () => {
    renderChips();

    const chips = [...els.chips.querySelectorAll(".chip")];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.map((c) => c.dataset.artist)).toContain("Gorillaz");
  });

  it("shows the visitor's own recent searches once there are any", () => {
    State.history = ["Drake", "Future"];
    renderChips();

    expect([...els.chips.querySelectorAll(".chip")].map((c) => c.dataset.artist)).toEqual([
      "Drake",
      "Future",
    ]);
  });

  it("shows at most five recent searches", () => {
    State.history = ["a", "b", "c", "d", "e", "f", "g"];
    renderChips();

    expect(els.chips.querySelectorAll(".chip")).toHaveLength(5);
  });

  it("labels the row differently for recents and for examples", () => {
    renderChips();
    const exampleLabel = els.chipsLabel.textContent;

    State.history = ["Drake"];
    renderChips();

    expect(els.chipsLabel.textContent).not.toBe(exampleLabel);
  });

  it("escapes markup in a remembered artist name", () => {
    State.history = ['<img src=x onerror="boom">'];
    renderChips();

    expect(els.chips.querySelector("img")).toBeNull();
    expect(els.chips.querySelector(".chip").textContent).toBe('<img src=x onerror="boom">');
  });

  it("does nothing on a page with no chips row", () => {
    els.chips = null;
    expect(() => renderChips()).not.toThrow();
  });

  it("works on a page that has chips but no label", () => {
    els.chipsLabel = null;
    expect(() => renderChips()).not.toThrow();
    expect(els.chips.querySelectorAll(".chip").length).toBeGreaterThan(0);
  });
});

describe("updateShareableUrl", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    State.graphNodes = [{ id: 7, name: "Drake" }];
    State.currentSeedId = 7;
    State.activeFilters = new Set(["featured"]);
    State.expandedNodes = new Set([7]);
    State.collabLimit = GRAPH_DEFAULT_LIMIT;
  });

  it("writes the current graph into the address bar", () => {
    updateShareableUrl("Drake");

    expect(window.location.search).toContain("artist=Drake");
  });

  it("falls back to the current seed's name when none is passed", () => {
    updateShareableUrl();
    expect(window.location.search).toContain("artist=Drake");
  });

  it("leaves the url alone when there is nothing to share yet", () => {
    State.graphNodes = [];
    State.currentSeedId = null;

    updateShareableUrl();

    expect(window.location.search).toBe("");
  });
});

describe("copyShareableLink", () => {
  beforeEach(async () => {
    const { showToast } = await import("./toast.js");
    showToast.mockClear?.();
  });

  it("confirms with a toast once the link is on the clipboard", async () => {
    const { showToast } = await import("./toast.js");
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue() } });

    copyShareableLink();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(showToast.mock.calls[0][0].toLowerCase()).toContain("copied");
    vi.unstubAllGlobals();
  });

  it("shows the link itself when the clipboard is not available", async () => {
    const { showToast } = await import("./toast.js");
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    copyShareableLink();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(showToast.mock.calls[0][0]).toContain(window.location.href);
    vi.unstubAllGlobals();
  });
});
