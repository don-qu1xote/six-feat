import { State, setPathHighlight } from "../state/state.js";
import { restoreDefaultColors } from "../vis-adapter/index.js";
export { highlightPath } from "../vis-adapter/index.js";

export function getBfsAdj() {
  if (State._bfsAdj) return State._bfsAdj;

  const adj = new Map();
  State.graphEdges.forEach((e) => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  });

  State._bfsAdj = adj;
  return adj;
}

export function bfsPath(fromId, toId) {
  const adj = getBfsAdj();
  if (!adj.has(fromId) || !adj.has(toId)) return null;

  const visited = new Set([fromId]);
  const queue = [[fromId, [fromId]]];

  while (queue.length) {
    const [curr, path] = queue.shift();
    if (curr === toId) return path;

    for (const nb of adj.get(curr) || []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([nb, [...path, nb]]);
      }
    }
  }

  return null;
}

export function clearPathHighlight() {
  if (!State.pathHighlight || !State.nodesDS) {
    setPathHighlight(null);
    return;
  }

  const { nodeIds } = State.pathHighlight;

  const unfixUpdates = nodeIds.map((id) => ({
    id,
    fixed: false,
  }));

  if (unfixUpdates.length) State.nodesDS.update(unfixUpdates);
  restoreDefaultColors();
  setPathHighlight(null);
}
