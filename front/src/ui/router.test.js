// ════════════════════════════════════════════════════════════════════════════
// router.test.js — [SF-WEB-25] minimal client-side routing (#/graph, #/game).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from "vitest";
import { State } from "../state/state.js";
import {
  SURFACE_GRAPH, SURFACE_GAME, DEFAULT_SURFACE,
  parseSurfaceFromHash, getCurrentSurface, onSurfaceChange,
  navigateToSurface, restoreSurfaceFromUrl,
} from "./router.js";

beforeEach(() => {
  history.replaceState(null, "", "http://localhost:3000/");
  State.surface = DEFAULT_SURFACE;
});

describe("parseSurfaceFromHash (pure)", () => {
  it("recognizes the two canonical surface hashes", () => {
    expect(parseSurfaceFromHash("#/graph")).toBe(SURFACE_GRAPH);
    expect(parseSurfaceFromHash("#/game")).toBe(SURFACE_GAME);
  });

  it("falls back to the default surface for a missing hash", () => {
    expect(parseSurfaceFromHash("")).toBe(DEFAULT_SURFACE);
    expect(parseSurfaceFromHash(undefined)).toBe(DEFAULT_SURFACE);
  });

  it("falls back to the default surface for an unrecognized hash", () => {
    expect(parseSurfaceFromHash("#/nonsense")).toBe(DEFAULT_SURFACE);
    expect(parseSurfaceFromHash("#/")).toBe(DEFAULT_SURFACE);
    expect(parseSurfaceFromHash("#graph-typo")).toBe(DEFAULT_SURFACE);
  });

  it("default surface is graph", () => {
    expect(DEFAULT_SURFACE).toBe(SURFACE_GRAPH);
  });
});

describe("navigateToSurface", () => {
  it("reflects graph<->game transitions in the URL hash", () => {
    navigateToSurface(SURFACE_GAME);
    expect(window.location.hash).toBe("#/game");
    expect(getCurrentSurface()).toBe(SURFACE_GAME);

    navigateToSurface(SURFACE_GRAPH);
    expect(window.location.hash).toBe("#/graph");
    expect(getCurrentSurface()).toBe(SURFACE_GRAPH);
  });

  it("updates State.surface", () => {
    navigateToSurface(SURFACE_GAME);
    expect(State.surface).toBe(SURFACE_GAME);
  });

  it("notifies onSurfaceChange listeners", () => {
    const fn = vi.fn();
    const unsubscribe = onSurfaceChange(fn);

    navigateToSurface(SURFACE_GAME);
    expect(fn).toHaveBeenCalledWith(SURFACE_GAME);

    unsubscribe();
    fn.mockClear();
    navigateToSurface(SURFACE_GRAPH);
    expect(fn).not.toHaveBeenCalled();
  });

  it("normalizes an invalid surface argument to the default", () => {
    navigateToSurface("not-a-real-surface");
    expect(window.location.hash).toBe("#/graph");
    expect(State.surface).toBe(SURFACE_GRAPH);
  });

  it("preserves the existing query string (composes with history.js's state encoding)", () => {
    history.replaceState(null, "", "http://localhost:3000/?artist=Drake&seed=1");
    navigateToSurface(SURFACE_GAME);
    expect(window.location.search).toBe("?artist=Drake&seed=1");
    expect(window.location.hash).toBe("#/game");
  });
});

describe("restoreSurfaceFromUrl", () => {
  it("restores game when the URL hash is #/game", () => {
    history.replaceState(null, "", "http://localhost:3000/#/game");
    expect(restoreSurfaceFromUrl()).toBe(SURFACE_GAME);
    expect(State.surface).toBe(SURFACE_GAME);
  });

  it("restores graph when the URL hash is #/graph", () => {
    history.replaceState(null, "", "http://localhost:3000/#/graph");
    expect(restoreSurfaceFromUrl()).toBe(SURFACE_GRAPH);
    expect(State.surface).toBe(SURFACE_GRAPH);
  });

  it("an invalid hash resolves to the default surface", () => {
    history.replaceState(null, "", "http://localhost:3000/#/totally-unknown");
    expect(restoreSurfaceFromUrl()).toBe(DEFAULT_SURFACE);
    expect(State.surface).toBe(DEFAULT_SURFACE);
  });

  it("a missing hash (current graph behavior) resolves to the default surface", () => {
    history.replaceState(null, "", "http://localhost:3000/");
    expect(restoreSurfaceFromUrl()).toBe(DEFAULT_SURFACE);
    expect(window.location.hash === "" || window.location.hash === "#/graph").toBe(true);
  });

  it("normalizes an invalid hash to the default surface's own URL", () => {
    history.replaceState(null, "", "http://localhost:3000/#/totally-unknown");
    restoreSurfaceFromUrl();
    expect(window.location.hash).toBe("#/graph");
  });
});

describe("graph <-> game round trip via the URL", () => {
  it("navigating away and restoring from the resulting URL reproduces the same surface", () => {
    navigateToSurface(SURFACE_GAME);
    const hashAfterNav = window.location.hash;

    // Simulate a fresh load picking up exactly the URL navigateToSurface left behind.
    history.replaceState(null, "", `http://localhost:3000/${hashAfterNav}`);
    State.surface = DEFAULT_SURFACE; // reset, as a real fresh load would start
    expect(restoreSurfaceFromUrl()).toBe(SURFACE_GAME);

    navigateToSurface(SURFACE_GRAPH);
    history.replaceState(null, "", `http://localhost:3000/${window.location.hash}`);
    State.surface = SURFACE_GAME;
    expect(restoreSurfaceFromUrl()).toBe(SURFACE_GRAPH);
  });
});

describe("popstate (browser back/forward)", () => {
  it("updates State.surface and notifies listeners on popstate", () => {
    const fn = vi.fn();
    const unsubscribe = onSurfaceChange(fn);

    history.pushState(null, "", "http://localhost:3000/#/game");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(State.surface).toBe(SURFACE_GAME);
    expect(fn).toHaveBeenCalledWith(SURFACE_GAME);
    unsubscribe();
  });
});
