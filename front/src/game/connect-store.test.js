import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/net.js", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "../api/net.js";
import { State } from "../state/state.js";
import {
  slice,
  setPhoto,
  setId,
  idFor,
  photoFor,
  eqName,
  endpointsReady,
  resolveId,
  isUnresolved,
  unresolvedNames,
  clearUnresolved,
  resolveArtistId,
  serializeGameShareState,
  parseGameShareState,
} from "./connect-store.js";

const okJson = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  apiFetch.mockReset();
  Object.assign(State.connect, {
    startName: "",
    goalName: "",
    game: null,
    photos: {},
    ids: {},
    frontier: null,
    rivalBanner: null,
    par: null,
    seasonId: null,
    submitted: false,
    unresolved: {},
  });
});

describe("slice()", () => {
  it("reads the declared state.js slice, not an ad-hoc global", () => {
    expect(slice()).toBe(State.connect);
    expect(State.game.connect).toBe(State.connect);
  });

  it("re-creates the nested caches if something wiped them", () => {
    State.connect.photos = null;
    State.connect.ids = null;
    const s = slice();
    expect(s.photos).toEqual({});
    expect(s.ids).toEqual({});
  });
});

describe("id / photo caches", () => {
  it("stores and reads back", () => {
    setId("Drake", 100);
    setPhoto("Drake", "d.jpg");
    expect(idFor("Drake")).toBe(100);
    expect(photoFor("Drake")).toBe("d.jpg");
  });

  it("returns null for an unknown name", () => {
    expect(idFor("Nobody")).toBeNull();
    expect(photoFor("Nobody")).toBeNull();
  });

  it("ignores empty names and null values instead of poisoning the cache", () => {
    setId("", 5);
    setId("X", null);
    setPhoto("Y", "");
    expect(slice().ids).toEqual({});
    expect(slice().photos).toEqual({});
  });

  it("keeps a real id of 0 addressable (?? not ||)", () => {
    setId("Zero", 0);
    expect(idFor("Zero")).toBe(0);
  });
});

describe("eqName / endpointsReady", () => {
  it("compares names case- and whitespace-insensitively", () => {
    expect(eqName("  drake ", "Drake")).toBe(true);
    expect(eqName("Drake", "Adele")).toBe(false);
    expect(eqName(null, undefined)).toBe(true);
  });

  it("needs BOTH endpoints non-blank", () => {
    expect(endpointsReady()).toBe(false);
    slice().startName = "Drake";
    expect(endpointsReady()).toBe(false);
    slice().goalName = "   ";
    expect(endpointsReady()).toBe(false);
    slice().goalName = "Adele";
    expect(endpointsReady()).toBe(true);
  });
});

describe("resolveId — [ADR-0009] имя → реальный Genius id", () => {
  it("takes the top search candidate and caches id + image", async () => {
    apiFetch.mockResolvedValue(okJson({ candidates: [{ id: 42, image: "a.jpg" }, { id: 7 }] }));
    expect(await resolveId("Adele")).toBe(42);
    expect(idFor("Adele")).toBe(42);
    expect(photoFor("Adele")).toBe("a.jpg");
  });

  it("never looks a name up twice", async () => {
    setId("Drake", 100);
    expect(await resolveId("Drake")).toBe(100);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("returns null (never a fake id) on a bad status, empty candidates or a throw", async () => {
    apiFetch.mockResolvedValue({ ok: false });
    expect(await resolveId("A")).toBeNull();

    apiFetch.mockResolvedValue(okJson({ candidates: [] }));
    expect(await resolveId("B")).toBeNull();

    apiFetch.mockRejectedValue(new Error("offline"));
    expect(await resolveId("C")).toBeNull();

    expect(slice().ids).toEqual({});
  });
});

describe("[SF-GAME-34 / ADR-0009] нерешённые имена", () => {
  it("marks a name unresolved when the search definitively has no artist", async () => {
    apiFetch.mockResolvedValue(okJson({ candidates: [] }));
    expect(await resolveId("Nobody At All")).toBeNull();
    expect(isUnresolved("Nobody At All")).toBe(true);
    expect(unresolvedNames()).toEqual(["Nobody At All"]);
  });

  it("does NOT mark it when the search couldn't be made — that's 'can't check', not 'doesn't exist'", async () => {
    apiFetch.mockResolvedValue({ ok: false });
    expect(await resolveId("Drake")).toBeNull();
    expect(isUnresolved("Drake")).toBe(false);

    apiFetch.mockRejectedValue(new Error("offline"));
    expect(await resolveId("Adele")).toBeNull();
    expect(isUnresolved("Adele")).toBe(false);

    expect(unresolvedNames()).toEqual([]);
  });

  it("clears the mark once the name does resolve", async () => {
    apiFetch.mockResolvedValue(okJson({ candidates: [] }));
    await resolveId("Drake");
    expect(isUnresolved("Drake")).toBe(true);

    slice().ids = {};
    apiFetch.mockResolvedValue(okJson({ candidates: [{ id: 100 }] }));
    expect(await resolveId("Drake")).toBe(100);
    expect(isUnresolved("Drake")).toBe(false);
  });

  it("clearUnresolved wipes the slate for a fresh round", async () => {
    apiFetch.mockResolvedValue(okJson({ candidates: [] }));
    await resolveId("X");
    expect(unresolvedNames()).toEqual(["X"]);
    clearUnresolved();
    expect(unresolvedNames()).toEqual([]);
  });
});

describe("[SF-GAME-34] resolveArtistId — резолв вне партии (админка)", () => {
  it("returns the top candidate's real id", async () => {
    apiFetch.mockResolvedValue(okJson({ candidates: [{ id: 555 }] }));
    expect(await resolveArtistId("Adele")).toBe(555);
  });

  it("returns null instead of 0/a fake id when nothing matches", async () => {
    apiFetch.mockResolvedValue(okJson({ candidates: [] }));
    expect(await resolveArtistId("Nobody")).toBeNull();
  });

  it("never pollutes the round's caches", async () => {
    apiFetch.mockResolvedValue(okJson({ candidates: [{ id: 555, image: "x.jpg" }] }));
    await resolveArtistId("Adele");
    expect(slice().ids).toEqual({});
    expect(slice().photos).toEqual({});
    expect(unresolvedNames()).toEqual([]);
  });

  it("treats a blank field as nothing to resolve", async () => {
    expect(await resolveArtistId("   ")).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("share link state", () => {
  it("round-trips both endpoint names", () => {
    const qs = serializeGameShareState({ from: "Drake", to: "Adele" }).toString();
    expect(parseGameShareState(qs)).toEqual({ from: "Drake", to: "Adele" });
  });

  it("omits missing halves and reads them back as null", () => {
    expect(serializeGameShareState({ from: "Drake" }).toString()).toBe("from=Drake");
    expect(parseGameShareState("")).toEqual({ from: null, to: null });
    expect(parseGameShareState(undefined)).toEqual({ from: null, to: null });
  });

  it("escapes names that need it", () => {
    const qs = serializeGameShareState({ from: "Tyler, The Creator", to: "A$AP" }).toString();
    expect(parseGameShareState(qs).from).toBe("Tyler, The Creator");
    expect(parseGameShareState(qs).to).toBe("A$AP");
  });
});
