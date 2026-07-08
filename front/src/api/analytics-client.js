// ════════════════════════════════════════════════════════════════════════════
// analytics-client.js — Client-side BFS path finding (fallback)
//
// ТЗ-F: bfsPath() is used by showArtistSidebar() to find the shortest path
//       from any node to the seed, then display it as an interactive chain.
// ════════════════════════════════════════════════════════════════════════════
import { State, setPathHighlight } from "../state/state.js";
import { els } from "../dom/dom.js";
import { restoreDefaultColors } from "../vis-adapter/index.js";
// ТЗ-204: highlightPath's DOM/vis.js logic moved into vis-adapter.js
// (applyDimState mode="path") — analytics-client.js stays pure BFS math.
// Re-exported here so existing `import { highlightPath } from "./analytics-client.js"`
// call sites keep working without touching every caller.
export { highlightPath } from "../vis-adapter/index.js";

/**
 * Build adjacency list from current graph edges.
 * Cached until State._bfsAdj is invalidated (nulled) by the graph-mutating
 * code paths (finalizeGraphState/mergePathData) — no hash recompute here.
 * @returns {Map<nodeId, nodeId[]>} Adjacency list: node → list of adjacent nodes
 */
export function getBfsAdj() {
  if (State._bfsAdj) return State._bfsAdj;

  const adj = new Map();
  State.graphEdges.forEach(e => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to))   adj.set(e.to,   []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  });

  State._bfsAdj = adj;
  return adj;
}

/**
 * Find shortest path between two nodes using BFS (breadth-first search).
 *
 * Usage in ТЗ-F:
 *   const path = bfsPath(selectedNodeId, seedNodeId);
 *   if (path) {
 *     console.log(path); // [nodeId1, nodeId2, ... seedNodeId]
 *     console.log("Hops:", path.length - 1);
 *   }
 *
 * @param {string|number} fromId — Start node ID
 * @param {string|number} toId   — End node ID
 * @returns {Array | null} Array of node IDs forming the shortest path, or null if unreachable
 */
export function bfsPath(fromId, toId) {
  const adj = getBfsAdj();
  if (!adj.has(fromId) || !adj.has(toId)) return null;

  const visited = new Set([fromId]);
  const queue   = [[fromId, [fromId]]];

  while (queue.length) {
    const [curr, path] = queue.shift();
    if (curr === toId) return path;

    for (const nb of (adj.get(curr) || [])) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([nb, [...path, nb]]);
      }
    }
  }

  return null; // No path found
}

// ════════════════════════════════════════════════════════════════════════════
// Path highlighting — for "six-degrees" finder (path panel)
// ТЗ-204: the actual highlight/dim logic (three-level dimming, DOM/vis.js
// updates) now lives in vis-adapter.js::applyDimState (mode="path"),
// re-exported above as `highlightPath`. Only the clear/reset flow stays
// here since it's tightly coupled to State.pathHighlight bookkeeping.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Clear path highlighting and restore default node/edge colors.
 */
export function clearPathHighlight() {
  if (!State.pathHighlight || !State.nodesDS) {
    setPathHighlight(null);
    return;
  }

  const { nodeIds } = State.pathHighlight;

  // Снимаем fixed со всех узлов пути
  const unfixUpdates = nodeIds.map(id => ({
    id,
    fixed: false
  }));

  if (unfixUpdates.length) State.nodesDS.update(unfixUpdates);
  restoreDefaultColors();
  setPathHighlight(null);
}
