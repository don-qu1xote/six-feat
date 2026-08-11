import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

vi.mock("../vis-adapter/index.js", () => ({
  restoreDefaultColors: vi.fn(),
  highlightPath: vi.fn(),
}));

import { State, clearGraphQueryCaches, clearLayoutCache } from "../state/state.js";
import * as analyticsClient from "./analytics-client.js";
import {
  fetchPathBetween,
  fetchEdgeDetails,
  fetchLayout,
  cachedLayout,
} from "./analytics-client.js";

const SOURCE = readFileSync(resolve(process.cwd(), "src/api/analytics-client.js"), "utf8");

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function pathResponse(path) {
  return jsonResponse({
    type: "path",
    hops: path.length - 1,
    path,
    nodes: path.map((id) => ({ id, name: `Artist ${id}` })),
    edges: [],
  });
}

beforeEach(() => {
  State.graphNodes = [];
  State.graphEdges = [];
  State.activeFilters = new Set(["featured", "producer", "writer"]);
  clearGraphQueryCaches();
  global.fetch = vi.fn();
});

afterEach(() => {
  delete global.fetch;
});

describe("[SF-API-24] the client no longer carries a breadth-first search", () => {
  it("exports no BFS entry points any more", () => {
    expect(analyticsClient.bfsPath).toBeUndefined();
    expect(analyticsClient.getBfsAdj).toBeUndefined();
  });

  it("contains no traversal of its own — the identifiers a BFS needs are absent", () => {
    // Проверка по исходнику, а не по экспортам: обход, переставший быть
    // экспортом, но оставшийся приватной функцией, — ровно тот второй
    // алгоритм, который эта задача убирает.
    const code = SOURCE.replace(/\/\/.*$/gm, "");
    for (const marker of ["bfs", "adjacency", "visited", "queue"]) {
      expect(code.toLowerCase()).not.toContain(marker);
    }
  });

  it("is imported by nobody for a traversal — no module pulls a BFS out of it", () => {
    // Удалить обход и оставить импорт — способ уронить сборку молча, поэтому
    // проверяется весь фронтенд, а не только этот модуль.
    const offenders = [];
    for (const file of sourceFiles(resolve(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      if (/\b(bfsPath|getBfsAdj|_bfsAdj)\b/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("asks the server instead — the single path endpoint, with the roles the client applies", async () => {
    global.fetch.mockResolvedValue(pathResponse([1, 7, 2]));
    State.activeFilters = new Set(["featured", "producer"]);

    const result = await fetchPathBetween(1, 2);

    expect(result.path).toEqual([1, 7, 2]);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain("/api/v1/graph/path?from=1&to=2");
    expect(url).toContain("roles=featured%2Cproducer");
  });

  it("returns nodes and edges from the response so off-canvas hops can be named", async () => {
    global.fetch.mockResolvedValue(pathResponse([1, 7, 2]));

    const result = await fetchPathBetween(1, 2);

    expect(result.nodes.map((n) => n.id)).toEqual([1, 7, 2]);
    expect(result.error).toBeNull();
  });
});

describe("[SF-API-24] per-pair cache for the lifetime of the graph", () => {
  it("serves a repeat request for the same pair from the cache", async () => {
    global.fetch.mockResolvedValue(pathResponse([1, 7, 2]));

    const first = await fetchPathBetween(1, 2);
    const second = await fetchPathBetween(1, 2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("treats the pair as unordered — the reversed query hits the same entry", async () => {
    global.fetch.mockResolvedValue(pathResponse([1, 7, 2]));

    await fetchPathBetween(1, 2);
    await fetchPathBetween(2, 1);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-asks when the role filter changes — that is a different question", async () => {
    global.fetch.mockResolvedValue(pathResponse([1, 7, 2]));

    await fetchPathBetween(1, 2);
    State.activeFilters = new Set(["featured"]);
    await fetchPathBetween(1, 2);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("re-asks after the cache is dropped with the graph", async () => {
    global.fetch.mockResolvedValue(pathResponse([1, 7, 2]));

    await fetchPathBetween(1, 2);
    clearGraphQueryCaches();
    await fetchPathBetween(1, 2);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("caches 'no path' too — it is an answer, not a failure", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ type: "path", error: "no_path", message: "No collaboration path found." }),
    );

    const first = await fetchPathBetween(1, 2);
    const second = await fetchPathBetween(1, 2);

    expect(first.path).toEqual([]);
    expect(first.error).toBe("no_path");
    expect(second).toBe(first);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["503 while the graph is still being enriched", 503, "deadline_exceeded"],
    ["401 before the user has signed in", 401, "not_authenticated"],
    ["422 before a Genius token is connected", 422, "no_genius_token"],
  ])("does not cache a %s — the user can fix it and retry", async (_name, status, error) => {
    global.fetch.mockResolvedValue(jsonResponse({ type: "path", error }, status));

    const first = await fetchPathBetween(1, 2);
    await fetchPathBetween(1, 2);

    expect(first.error).toBe(error);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("passes the server's message through so the panel can show the real reason", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse(
        { type: "path", error: "no_genius_token", message: "Connect a Genius token in Settings." },
        422,
      ),
    );

    const result = await fetchPathBetween(1, 2);

    expect(result.message).toBe("Connect a Genius token in Settings.");
  });
});

describe("[SF-API-23] edge details are fetched on expand, once per pair", () => {
  const edgeResponse = (songs) =>
    jsonResponse({
      type: "graph_edge",
      from: 1,
      to: 2,
      collaboration_count: songs.length,
      dominant_role: "featured",
      collaborations: songs.map((song, i) => ({ song, popularity: 100 - i, roles: ["featured"] })),
    });

  it("asks the edge endpoint with the roles the client applies", async () => {
    global.fetch.mockResolvedValue(edgeResponse(["A", "B"]));
    State.activeFilters = new Set(["featured", "producer"]);

    const result = await fetchEdgeDetails(1, 2);

    expect(result.collaborations.map((c) => c.song)).toEqual(["A", "B"]);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain("/api/v1/graph/edge?from=1&to=2");
    expect(url).toContain("roles=featured%2Cproducer");
  });

  it("serves a second expand of the same edge from the cache, either way round", async () => {
    global.fetch.mockResolvedValue(edgeResponse(["A"]));

    const first = await fetchEdgeDetails(1, 2);
    const second = await fetchEdgeDetails(1, 2);
    const reversed = await fetchEdgeDetails(2, 1);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(reversed).toBe(first);
  });

  it("re-asks after the graph is replaced, and when the role filter changes", async () => {
    global.fetch.mockResolvedValue(edgeResponse(["A"]));

    await fetchEdgeDetails(1, 2);
    clearGraphQueryCaches();
    await fetchEdgeDetails(1, 2);
    State.activeFilters = new Set(["featured"]);
    await fetchEdgeDetails(1, 2);

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("reports a failure instead of pretending the edge has no tracks", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ error: "not_authenticated" }, 401));

    const result = await fetchEdgeDetails(1, 2);

    expect(result.collaborations).toEqual([]);
    expect(result.error).toBe("not_authenticated");
    // 401 поправим входом — кэшировать нечего.
    await fetchEdgeDetails(1, 2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

// [SF-API-21] Раскладка на сервере.
describe("[SF-API-21] fetchLayout / cachedLayout", () => {
  const REQUEST = {
    seed_id: 1,
    nodes: [1, 2, 3],
    edges: [
      [1, 2],
      [1, 3],
    ],
    expanded: [1],
    expand_parent: {},
    pinned: {},
    node_radius: 22,
    node_gap: 34,
  };

  function layoutResponse(positions, contours = []) {
    return jsonResponse({ type: "graph_layout", positions, contours });
  }

  beforeEach(() => {
    clearLayoutCache();
  });

  it("posts the structure and returns the coordinates keyed by id", async () => {
    global.fetch.mockResolvedValueOnce(
      layoutResponse([
        { id: 2, x: 150, y: 0 },
        { id: 3, x: -150, y: 0 },
      ]),
    );

    const answer = await fetchLayout(REQUEST);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/v1/graph/layout");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual(REQUEST);
    expect(answer.positions.get(2)).toEqual({ x: 150, y: 0 });
    expect(answer.positions.get(3)).toEqual({ x: -150, y: 0 });
  });

  // [SF-API-22] Контуры едут тем же ответом, что и координаты: они из этих
  // координат и выведены, и второй запрос за ними означал бы пересчитать
  // раскладку заново ради тех же чисел.
  it("carries the group outlines back with the coordinates they were built from", async () => {
    const outline = [
      {
        hub: 1,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    ];
    global.fetch.mockResolvedValueOnce(layoutResponse([{ id: 2, x: 1, y: 2 }], outline));

    const answer = await fetchLayout(REQUEST);

    expect(answer.contours).toEqual(outline);
  });

  it("treats an answer without outlines as an answer with none, not as a broken answer", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ type: "graph_layout", positions: [] }));

    const answer = await fetchLayout(REQUEST);

    expect(answer.contours).toEqual([]);
    expect(answer.positions.size).toBe(0);
  });

  it("asks the server once per structure — the second time the answer is already here", async () => {
    global.fetch.mockResolvedValueOnce(layoutResponse([{ id: 2, x: 1, y: 2 }]));
    await fetchLayout(REQUEST);
    await fetchLayout({ ...REQUEST });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // Главное требование тикета: раскрытие, чей ответ уже известен, было
  // мгновенным до переноса геометрии и обязано остаться мгновенным после.
  // Поэтому кэш спрашивается СИНХРОННО — не промисом, не микрозадачей.
  it("answers a known structure synchronously, without touching the network", async () => {
    global.fetch.mockResolvedValueOnce(layoutResponse([{ id: 2, x: 9, y: 8 }]));
    await fetchLayout(REQUEST);
    global.fetch.mockClear();

    const answer = cachedLayout({ ...REQUEST });

    expect(answer.positions).toBeInstanceOf(Map);
    expect(answer.positions.get(2)).toEqual({ x: 9, y: 8 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not answer from cache for a structure it has not seen", async () => {
    global.fetch.mockResolvedValueOnce(layoutResponse([{ id: 2, x: 9, y: 8 }]));
    await fetchLayout(REQUEST);
    expect(cachedLayout({ ...REQUEST, expanded: [1, 2] })).toBeNull();
  });

  it("treats a dragged pole as a different question, not the same one", async () => {
    const pinnedAt = (x, y) => ({ ...REQUEST, pinned: { 2: { x, y } } });
    global.fetch.mockResolvedValue(layoutResponse([{ id: 3, x: 0, y: 0 }]));

    await fetchLayout(pinnedAt(100, 100));
    expect(cachedLayout(pinnedAt(100, 100))).not.toBeNull();
    expect(cachedLayout(pinnedAt(400, 100))).toBeNull();
  });

  it("has nothing to answer and nothing to ask when there is no graph yet", async () => {
    expect(cachedLayout(null)).toBeNull();
    await expect(fetchLayout(null)).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when the server refuses", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "rate limit exceeded" }, 429));
    await expect(fetchLayout(REQUEST)).resolves.toBeNull();
    expect(cachedLayout(REQUEST)).toBeNull();
  });

  it("returns null instead of throwing when the network is down", async () => {
    global.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchLayout(REQUEST)).resolves.toBeNull();
  });

  it("keeps an abort an abort — a cancelled expansion is not a failed layout", async () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    global.fetch.mockRejectedValueOnce(aborted);
    await expect(fetchLayout(REQUEST)).rejects.toThrow("aborted");
  });
});
