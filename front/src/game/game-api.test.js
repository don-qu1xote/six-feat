// ════════════════════════════════════════════════════════════════════════════
// game-api.test.js — unit tests for the game service client (game-api.js).
// apiFetch (../api/net.js) is mocked so these exercise only the request
// shaping + response mapping (ok → parsed JSON, non-ok / throw → null, and
// checkLink's three-state verdict).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/net.js", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "../api/net.js";
import {
  createChallenge, submitChain, fetchDailyChallenge, fetchChallenge, fetchChallenges,
  fetchLeaderboard, fetchSeasonLeaderboard, fetchProfile, fetchPublicProfile,
  fetchSeason, fetchAdminStatus, publishDaily, checkLink, updateDisplayName,
} from "./game-api.js";

const ok = body => ({ ok: true, json: async () => body });
const notOk = (status = 500) => ({ ok: false, status, json: async () => null });

beforeEach(() => { apiFetch.mockReset(); });

describe("GET reads (getJson)", () => {
  it("fetchDailyChallenge hits the daily endpoint and returns the body", async () => {
    apiFetch.mockResolvedValue(ok({ id: 7, from_name: "Drake" }));
    expect(await fetchDailyChallenge()).toEqual({ id: 7, from_name: "Drake" });
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/challenge?daily=1");
  });

  it("returns null on a non-ok status (e.g. 404 no daily yet)", async () => {
    apiFetch.mockResolvedValue(notOk(404));
    expect(await fetchDailyChallenge()).toBeNull();
  });

  it("returns null when apiFetch throws (transport error)", async () => {
    apiFetch.mockRejectedValue(new Error("network"));
    expect(await fetchDailyChallenge()).toBeNull();
  });

  it("fetchChallenge encodes the id", async () => {
    apiFetch.mockResolvedValue(ok({ id: 12 }));
    await fetchChallenge(12);
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/challenge?id=12");
  });

  it("fetchProfile / fetchSeason hit their endpoints", async () => {
    apiFetch.mockResolvedValue(ok({}));
    await fetchProfile();
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/profile");
    await fetchSeason();
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/season");
  });

  it("fetchPublicProfile encodes the user id", async () => {
    apiFetch.mockResolvedValue(ok({ user_id: 5 }));
    await fetchPublicProfile(5);
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/profile?user=5");
  });
});

describe("fetchChallenges query building", () => {
  it("omits all params when none given", async () => {
    apiFetch.mockResolvedValue(ok({ challenges: [] }));
    await fetchChallenges();
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/challenges");
  });

  it("includes kind, cursor and limit when provided", async () => {
    apiFetch.mockResolvedValue(ok({ challenges: [] }));
    await fetchChallenges({ kind: "daily", cursor: "100:5", limit: 24 });
    const url = apiFetch.mock.calls[0][0];
    expect(url).toContain("kind=daily");
    expect(url).toContain("cursor=100%3A5");
    expect(url).toContain("limit=24");
  });
});

describe("leaderboards", () => {
  it("fetchLeaderboard uses challenge_id and optional cursor/limit", async () => {
    apiFetch.mockResolvedValue(ok({ entries: [] }));
    await fetchLeaderboard(7);
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/leaderboard?challenge_id=7");
    await fetchLeaderboard(7, { cursor: "c", limit: 50 });
    const url = apiFetch.mock.calls[1][0];
    expect(url).toContain("challenge_id=7");
    expect(url).toContain("cursor=c");
    expect(url).toContain("limit=50");
  });

  it("fetchSeasonLeaderboard uses season_id", async () => {
    apiFetch.mockResolvedValue(ok({ entries: [] }));
    await fetchSeasonLeaderboard(3, { limit: 10 });
    const url = apiFetch.mock.calls[0][0];
    expect(url).toContain("season_id=3");
    expect(url).toContain("limit=10");
  });
});

describe("POST writes (postJson)", () => {
  it("createChallenge posts a JSON body with the role mask", async () => {
    apiFetch.mockResolvedValue(ok({ id: 1 }));
    await createChallenge(100, 900, 0);
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/v1/game/challenge");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ from: 100, to: 900, role_mask: 0 });
  });

  it("createChallenge defaults role mask to 0", async () => {
    apiFetch.mockResolvedValue(ok({ id: 1 }));
    await createChallenge(1, 2);
    expect(JSON.parse(apiFetch.mock.calls[0][1].body).role_mask).toBe(0);
  });

  it("submitChain posts challenge_id, chain and elapsed_ms", async () => {
    apiFetch.mockResolvedValue(ok({ valid: true }));
    await submitChain(7, [1, 2], 4200);
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({
      challenge_id: 7, chain: [1, 2], elapsed_ms: 4200,
    });
  });

  it("returns null when a POST fails", async () => {
    apiFetch.mockResolvedValue(notOk(403));
    expect(await createChallenge(1, 2, 0)).toBeNull();
  });

  it("returns null when a POST throws", async () => {
    apiFetch.mockRejectedValue(new Error("net"));
    expect(await submitChain(7, [1, 2], 0)).toBeNull();
  });
});

describe("admin", () => {
  it("fetchAdminStatus is true only when the body says admin:true", async () => {
    apiFetch.mockResolvedValue(ok({ admin: true }));
    expect(await fetchAdminStatus()).toBe(true);
  });
  it("fetchAdminStatus is false for admin:false / null / failure", async () => {
    apiFetch.mockResolvedValue(ok({ admin: false }));
    expect(await fetchAdminStatus()).toBe(false);
    apiFetch.mockResolvedValue(notOk(401));
    expect(await fetchAdminStatus()).toBe(false);
  });

  it("publishDaily omits blank endpoints (random pair)", async () => {
    apiFetch.mockResolvedValue(ok({ id: 9 }));
    await publishDaily();
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({});
  });

  it("publishDaily includes a supplied pair", async () => {
    apiFetch.mockResolvedValue(ok({ id: 9 }));
    await publishDaily({ from: 11, to: 22 });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ from: 11, to: 22 });
  });
});

describe("updateDisplayName (PATCH)", () => {
  it("PATCHes the display_name and returns the refreshed profile", async () => {
    apiFetch.mockResolvedValue(ok({ display_name: "New" }));
    const res = await updateDisplayName("New");
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/v1/game/profile");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ display_name: "New" });
    expect(res).toEqual({ display_name: "New" });
  });

  it("returns null when the name is rejected (non-ok) or the call throws", async () => {
    apiFetch.mockResolvedValue(notOk(400));
    expect(await updateDisplayName("bad")).toBeNull();
    apiFetch.mockRejectedValue(new Error("net"));
    expect(await updateDisplayName("x")).toBeNull();
  });
});

describe("checkLink three-state verdict", () => {
  it("passes through a boolean true/false", async () => {
    apiFetch.mockResolvedValue(ok({ linked: true }));
    expect(await checkLink(1, 2)).toEqual({ linked: true });
    apiFetch.mockResolvedValue(ok({ linked: false }));
    expect(await checkLink(1, 2)).toEqual({ linked: false });
  });

  it("collapses a JSON null / missing field to { linked: null }", async () => {
    apiFetch.mockResolvedValue(ok({ linked: null }));
    expect(await checkLink(1, 2)).toEqual({ linked: null });
    apiFetch.mockResolvedValue(ok({}));
    expect(await checkLink(1, 2)).toEqual({ linked: null });
  });

  it("collapses a failed lookup to { linked: null } (fail open)", async () => {
    apiFetch.mockResolvedValue(notOk(502));
    expect(await checkLink(1, 2)).toEqual({ linked: null });
  });

  it("encodes both ids", async () => {
    apiFetch.mockResolvedValue(ok({ linked: true }));
    await checkLink(100, 900);
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/link?from=100&to=900");
  });
});
