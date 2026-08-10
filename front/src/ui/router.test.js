import { describe, it, expect, beforeEach, vi } from "vitest";
import { State } from "../state/state.js";
import {
  SURFACE_GRAPH,
  SURFACE_GAME,
  SURFACE_GAME_SEASON,
  DEFAULT_SURFACE,
  parseSurfaceFromHash,
  getCurrentSurface,
  onSurfaceChange,
  navigateToSurface,
  restoreSurfaceFromUrl,
  isGameSurface,
} from "./router.js";

beforeEach(() => {
  history.replaceState(null, "", "http://localhost:3000/");
  State.surface = DEFAULT_SURFACE;
});

describe("parseSurfaceFromHash (pure)", () => {
  it("maps every known hash to its surface and everything else to the default", () => {
    expect(DEFAULT_SURFACE).toBe(SURFACE_GRAPH);
    expect(parseSurfaceFromHash("#/graph")).toBe(SURFACE_GRAPH);
    expect(parseSurfaceFromHash("#/game")).toBe(SURFACE_GAME);
    expect(parseSurfaceFromHash("#/game/season")).toBe(SURFACE_GAME_SEASON);
    expect(isGameSurface(SURFACE_GAME_SEASON)).toBe(true);

    for (const junk of ["", undefined, "#/nonsense", "#/", "#graph-typo"]) {
      expect(parseSurfaceFromHash(junk)).toBe(DEFAULT_SURFACE);
    }
  });
});

describe("navigateToSurface", () => {
  it("writes the hash, updates State.surface and notifies listeners until they unsubscribe", () => {
    const fn = vi.fn();
    const unsubscribe = onSurfaceChange(fn);

    navigateToSurface(SURFACE_GAME);
    expect(window.location.hash).toBe("#/game");
    expect(getCurrentSurface()).toBe(SURFACE_GAME);
    expect(State.surface).toBe(SURFACE_GAME);
    expect(fn).toHaveBeenCalledWith(SURFACE_GAME);

    unsubscribe();
    fn.mockClear();

    navigateToSurface(SURFACE_GRAPH);
    expect(window.location.hash).toBe("#/graph");
    expect(fn).not.toHaveBeenCalled();
  });

  it("normalises an unknown surface and never disturbs the query string", () => {
    history.replaceState(null, "", "http://localhost:3000/?artist=Drake&seed=1");

    navigateToSurface("not-a-real-surface");

    expect(State.surface).toBe(SURFACE_GRAPH);
    expect(window.location.hash).toBe("#/graph");
    expect(window.location.search).toBe("?artist=Drake&seed=1");
  });
});

describe("restoreSurfaceFromUrl", () => {
  it.each([
    ["#/game", SURFACE_GAME],
    ["#/graph", SURFACE_GRAPH],
    ["#/totally-unknown", DEFAULT_SURFACE],
    ["", DEFAULT_SURFACE],
  ])("resolves %s to its surface and mirrors it into State", (hash, expected) => {
    history.replaceState(null, "", `http://localhost:3000/${hash}`);

    expect(restoreSurfaceFromUrl()).toBe(expected);
    expect(State.surface).toBe(expected);
  });

  it("rewrites an unknown hash to the default surface's own URL", () => {
    history.replaceState(null, "", "http://localhost:3000/#/totally-unknown");

    restoreSurfaceFromUrl();

    expect(window.location.hash).toBe("#/graph");
  });

  it("round-trips: whatever navigateToSurface wrote is what restore reads back", () => {
    for (const surface of [SURFACE_GAME, SURFACE_GRAPH]) {
      navigateToSurface(surface);
      history.replaceState(null, "", `http://localhost:3000/${window.location.hash}`);
      State.surface = null;

      expect(restoreSurfaceFromUrl()).toBe(surface);
    }
  });
});

describe("browser navigation", () => {
  // popstate — кнопка «назад», hashchange — обычная ссылка <a href="#/graph">
  // (ей пользуется сама игра, чтобы вернуться на граф). Оба события обязаны
  // двигать State и слушателей: на одном popstate ссылка ничего не меняла.
  it.each([
    ["popstate", () => new PopStateEvent("popstate")],
    ["hashchange", () => new HashChangeEvent("hashchange")],
  ])("%s moves State.surface and notifies listeners", (_name, makeEvent) => {
    const fn = vi.fn();
    const unsubscribe = onSurfaceChange(fn);
    try {
      history.pushState(null, "", "http://localhost:3000/#/game");
      window.dispatchEvent(makeEvent());

      expect(State.surface).toBe(SURFACE_GAME);
      expect(fn).toHaveBeenCalledWith(SURFACE_GAME);
    } finally {
      unsubscribe();
    }
  });
});
