// ════════════════════════════════════════════════════════════════════════════
// state.test.js — unit tests for the _graphCache LRU eviction logic
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { GRAPH_CACHE_MAX, setGraphCacheEntry } from "./state.js";

describe("GRAPH_CACHE_MAX", () => {
  it("is 20, matching the documented cap", () => {
    expect(GRAPH_CACHE_MAX).toBe(20);
  });
});

describe("setGraphCacheEntry", () => {
  it("inserts entries under the cap without evicting anything", () => {
    const cache = new Map();
    for (let i = 0; i < GRAPH_CACHE_MAX; i++) {
      setGraphCacheEntry(cache, i, { graph: { id: i } });
    }
    expect(cache.size).toBe(GRAPH_CACHE_MAX);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(GRAPH_CACHE_MAX - 1)).toBe(true);
  });

  it("evicts the oldest entry once the cap is exceeded", () => {
    const cache = new Map();
    for (let i = 0; i < GRAPH_CACHE_MAX; i++) {
      setGraphCacheEntry(cache, i, { graph: { id: i } });
    }
    // 21st insert should evict key 0 (the oldest).
    setGraphCacheEntry(cache, GRAPH_CACHE_MAX, { graph: { id: GRAPH_CACHE_MAX } });

    expect(cache.size).toBe(GRAPH_CACHE_MAX);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(1)).toBe(true);
    expect(cache.has(GRAPH_CACHE_MAX)).toBe(true);
  });

  it("evicts in strict insertion order across many overflows", () => {
    const cache = new Map();
    const total = GRAPH_CACHE_MAX + 5;
    for (let i = 0; i < total; i++) {
      setGraphCacheEntry(cache, i, { graph: { id: i } });
    }
    // Only the most recent GRAPH_CACHE_MAX keys should survive.
    for (let i = 0; i < total - GRAPH_CACHE_MAX; i++) {
      expect(cache.has(i)).toBe(false);
    }
    for (let i = total - GRAPH_CACHE_MAX; i < total; i++) {
      expect(cache.has(i)).toBe(true);
    }
    expect(cache.size).toBe(GRAPH_CACHE_MAX);
  });

  it("re-inserting an existing key refreshes its recency instead of duplicating it", () => {
    const cache = new Map();
    for (let i = 0; i < GRAPH_CACHE_MAX; i++) {
      setGraphCacheEntry(cache, i, { graph: { id: i } });
    }
    // Touch key 0 again — it should now be the most-recently-used entry
    // and survive the next eviction, while key 1 (now oldest) gets evicted.
    setGraphCacheEntry(cache, 0, { graph: { id: 0, refreshed: true } });
    setGraphCacheEntry(cache, GRAPH_CACHE_MAX, { graph: { id: GRAPH_CACHE_MAX } });

    expect(cache.size).toBe(GRAPH_CACHE_MAX);
    expect(cache.has(0)).toBe(true);
    expect(cache.get(0).graph.refreshed).toBe(true);
    expect(cache.has(1)).toBe(false);
  });

  it("stores the exact value object passed in", () => {
    const cache = new Map();
    const value = { graph: { seed_id: 42 }, timestamp: 123456 };
    setGraphCacheEntry(cache, 42, value);
    expect(cache.get(42)).toBe(value);
  });
});
