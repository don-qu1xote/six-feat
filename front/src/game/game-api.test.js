import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/net.js", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "../api/net.js";
import {
  createChallenge,
  submitChain,
  fetchDailyChallenge,
  fetchChallenge,
  fetchChallenges,
  fetchLeaderboard,
  fetchSeasonLeaderboard,
  fetchProfile,
  fetchPublicProfile,
  fetchSeason,
  fetchAdminStatus,
  publishDaily,
  checkLink,
  updateDisplayName,
} from "./game-api.js";

const ok = (body) => ({ ok: true, json: async () => body });
const notOk = (status = 500) => ({ ok: false, status, json: async () => null });

beforeEach(() => {
  apiFetch.mockReset();
});

describe("GET reads", () => {
  it.each([
    ["fetchDailyChallenge", () => fetchDailyChallenge(), "/api/v1/game/challenge?daily=1"],
    ["fetchChallenge", () => fetchChallenge(12), "/api/v1/game/challenge?id=12"],
    ["fetchProfile", () => fetchProfile(), "/api/v1/game/profile"],
    ["fetchPublicProfile", () => fetchPublicProfile(5), "/api/v1/game/profile?user=5"],
    ["fetchSeason", () => fetchSeason(), "/api/v1/game/season"],
    ["fetchChallenges", () => fetchChallenges(), "/api/v1/game/challenges"],
  ])("%s calls %s and returns the body", async (_name, call, url) => {
    apiFetch.mockResolvedValue(ok({ id: 7 }));

    expect(await call()).toEqual({ id: 7 });
    expect(apiFetch).toHaveBeenCalledWith(url);
  });

  it("collapses a non-ok status and a transport error alike to null", async () => {
    apiFetch.mockResolvedValue(notOk(404));
    expect(await fetchDailyChallenge()).toBeNull();

    apiFetch.mockRejectedValue(new Error("network"));
    expect(await fetchDailyChallenge()).toBeNull();
  });

  it("builds paging and filter query strings only from the params it was given", async () => {
    apiFetch.mockResolvedValue(ok({ challenges: [] }));

    await fetchChallenges({ kind: "daily", cursor: "100:5", limit: 24 });
    expect(apiFetch.mock.calls[0][0]).toContain("kind=daily");
    expect(apiFetch.mock.calls[0][0]).toContain("cursor=100%3A5");
    expect(apiFetch.mock.calls[0][0]).toContain("limit=24");

    await fetchLeaderboard(7);
    expect(apiFetch.mock.calls[1][0]).toBe("/api/v1/game/leaderboard?challenge_id=7");

    await fetchLeaderboard(7, { cursor: "c", limit: 50 });
    expect(apiFetch.mock.calls[2][0]).toContain("cursor=c");

    await fetchSeasonLeaderboard(3, { limit: 10 });
    expect(apiFetch.mock.calls[3][0]).toContain("season_id=3");
    expect(apiFetch.mock.calls[3][0]).toContain("limit=10");
  });
});

describe("writes", () => {
  it("createChallenge posts the pair as JSON, defaulting the role mask to 0", async () => {
    apiFetch.mockResolvedValue(ok({ id: 1 }));

    await createChallenge(100, 900, 0);
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/v1/game/challenge");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ from: 100, to: 900, role_mask: 0 });

    await createChallenge(1, 2);
    expect(JSON.parse(apiFetch.mock.calls[1][1].body).role_mask).toBe(0);
  });

  it("submitChain posts the challenge, the chain and the elapsed time", async () => {
    apiFetch.mockResolvedValue(ok({ valid: true }));

    await submitChain(7, [1, 2], 4200);

    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({
      challenge_id: 7,
      chain: [1, 2],
      elapsed_ms: 4200,
    });
  });

  it("updateDisplayName PATCHes the name and hands back the refreshed profile", async () => {
    apiFetch.mockResolvedValue(ok({ display_name: "New" }));

    const res = await updateDisplayName("New");

    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/v1/game/profile");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ display_name: "New" });
    expect(res).toEqual({ display_name: "New" });
  });

  it("returns null from any write the server rejected or the transport lost", async () => {
    apiFetch.mockResolvedValue(notOk(403));
    expect(await createChallenge(1, 2, 0)).toBeNull();
    expect(await updateDisplayName("bad")).toBeNull();

    apiFetch.mockRejectedValue(new Error("net"));
    expect(await submitChain(7, [1, 2], 0)).toBeNull();
    expect(await updateDisplayName("x")).toBeNull();
  });
});

describe("admin", () => {
  it("fetchAdminStatus is true only when the body says so", async () => {
    apiFetch.mockResolvedValue(ok({ admin: true }));
    expect(await fetchAdminStatus()).toBe(true);

    apiFetch.mockResolvedValue(ok({ admin: false }));
    expect(await fetchAdminStatus()).toBe(false);

    apiFetch.mockResolvedValue(notOk(401));
    expect(await fetchAdminStatus()).toBe(false);
  });

  it("publishDaily sends a pair when given one and an empty body for a random one", async () => {
    apiFetch.mockResolvedValue(ok({ id: 9 }));

    await publishDaily();
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({});

    await publishDaily({ from: 11, to: 22 });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ from: 11, to: 22 });
  });
});

describe("checkLink three-state verdict", () => {
  it("passes a real yes/no through and encodes both ids", async () => {
    apiFetch.mockResolvedValue(ok({ linked: true }));
    expect(await checkLink(100, 900)).toEqual({ linked: true });
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/game/link?from=100&to=900");

    apiFetch.mockResolvedValue(ok({ linked: false }));
    expect(await checkLink(1, 2)).toEqual({ linked: false });
  });

  it("fails open to 'unknown' for a null, a missing field or a failed lookup", async () => {
    for (const response of [ok({ linked: null }), ok({}), notOk(502)]) {
      apiFetch.mockResolvedValue(response);
      expect(await checkLink(1, 2)).toEqual({ linked: null });
    }
  });
});
