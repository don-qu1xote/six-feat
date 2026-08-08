import {
  State,
  COLOR,
  setSeed,
  setNodes,
  setEdges,
  addNodes,
  addEdges,
  resetExpansionState,
  setTruncation,
} from "./state/state.js";
import {
  roleStyle,
  allRolesFromCollabs,
  sortByPopularity,
  isGeniusDefaultAvatar,
} from "./state/helpers.js";
import {
  resolveEdgeDominantRole,
  computeNodeSizes,
  initGraphOnCanvas,
  initNetwork,
  refreshNetwork,
  mergeNetwork,
  edgeVisual,
  invalidateColorCache,
} from "./vis-adapter/index.js";
import { els } from "./dom/dom.js";
import { hideArtistSidebar } from "./ui/sidebar.js";
import { updateStatus, updateTruncationBanner } from "./ui/canvas-controls.js";
import { renderGraphA11yList } from "./ui/index.js";

export function replaceGraph(graph) {
  const seedId = graph.seedId ?? graph.nodes[0]?.id;

  const savedPositions = State.network ? State.network.getPositions() : {};
  const nameById = {};
  graph.nodes.forEach((n) => {
    nameById[n.id] = n.name || "";
  });

  resetExpansionState();

  const existingIds = new Set(State.graphNodes.map((n) => n.id));
  setNodes(graph.nodes.map((n) => buildNodeState(n, seedId, existingIds, graph)));
  setEdges(graph.edges.map((e) => buildEdgeState(e)));

  State.graphNodes.forEach((n) => {
    n._isNew = false;
  });

  finalizeGraphState(seedId, nameById, savedPositions, graph, false);
}

export function mergeGraph(graph) {
  const expandedId = graph.seedId ?? graph.nodes[0]?.id;

  const priorPoles = new Set(State.expandedNodes);

  const savedPositions = State.network ? State.network.getPositions() : {};

  const existingNodeIds = new Set(State.graphNodes.map((n) => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map((e) => edgeKey(e.from, e.to)));

  const nameById = {};
  State.graphNodes.forEach((n) => {
    nameById[n.id] = n.name;
  });
  graph.nodes.forEach((n) => {
    nameById[n.id] = n.name || "";
  });

  const newNodes = [];
  for (const n of graph.nodes) {
    if (!existingNodeIds.has(n.id)) newNodes.push(buildNodeState(n, null, existingNodeIds, graph));
  }
  addNodes(newNodes);

  const newEdges = [];
  for (const e of graph.edges) {
    if (!existingEdgeKeys.has(edgeKey(e.from, e.to))) newEdges.push(buildEdgeState(e));
  }
  addEdges(newEdges);

  State.expandedNodes.add(expandedId);
  State.lastExpandedId = expandedId;

  const expandedNode = State.graphNodes.find((n) => n.id === expandedId);
  if (expandedNode && expandedNode._expandParent == null) {
    let parent = null;
    for (const e of State.graphEdges) {
      const other = e.from === expandedId ? e.to : e.to === expandedId ? e.from : null;
      if (other == null) continue;
      if (other === State.currentSeedId) {
        parent = other;
        break;
      }
      if (parent == null && priorPoles.has(other)) parent = other;
    }
    expandedNode._expandParent = parent ?? State.currentSeedId ?? null;
  }

  finalizeGraphState(State.currentSeedId, nameById, savedPositions, graph, true);
}

export function mergeDeepenResult(deepen) {
  const savedPositions = State.network ? State.network.getPositions() : {};

  const existingNodeIds = new Set(State.graphNodes.map((n) => n.id));
  const nameById = {};
  State.graphNodes.forEach((n) => {
    nameById[n.id] = n.name;
  });

  const newNodes = [];
  for (const n of deepen.nodes || []) {
    if (existingNodeIds.has(n.id)) continue;
    newNodes.push(buildNodeState(n, null, existingNodeIds, deepen));
    nameById[n.id] = n.name || "";
  }
  addNodes(newNodes);

  const existingEdgeByKey = new Map(State.graphEdges.map((e) => [edgeKey(e.from, e.to), e]));
  const newEdges = [];
  const mergedEdges = [];

  for (const e of deepen.edges || []) {
    const key = edgeKey(e.from, e.to);
    const existing = existingEdgeByKey.get(key);
    if (!existing) {
      newEdges.push(buildEdgeState(e));
      continue;
    }
    existing.collaborations = [...(existing.collaborations || []), ...(e.collaborations || [])];
    existing.dominantRole = resolveEdgeDominantRole({
      collaborations: existing.collaborations,
      dominantRole: existing.dominantRole,
      dominant_role: e.dominant_role,
    });
    mergedEdges.push(existing);
  }
  addEdges(newEdges);

  computeNodeSizes();
  finalizeNodeRoleState();
  invalidateColorCache();
  renderGraphA11yList();
  State._bfsAdj = null;

  if (State.network) {
    mergeNetwork(nameById, savedPositions);
    if (State.edgesDS) {
      for (const e of mergedEdges) {
        if (State.edgesDS.get(e.id)) State.edgesDS.update(edgeVisual(e, nameById));
      }
    }
  }

  return {
    addedNodes: newNodes.length,
    addedEdges: newEdges.length,
    mergedEdges: mergedEdges.length,
  };
}

export function buildNodeState(n, seedId, existingIds, _graph) {
  const isSeed = n.id === seedId;
  const domRole = "primary";
  const rs = roleStyle(domRole);
  const accent = isSeed ? COLOR.signal : rs.color;
  const dimBorder = isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;

  const imageUrl = n.image && !isGeniusDefaultAvatar(n.image) ? n.image : "";

  return {
    id: n.id,
    name: n.name || "",
    imageUrl,
    geniusUrl: n.url || null,
    genres: [],
    isSeed: isSeed,
    // [SF-YM-09] Absent on older cached responses — default to available
    // rather than hiding the affordance for data the backend hasn't
    // annotated yet.
    deepenAvailable: n.deepen_available ?? true,
    _isNew: existingIds ? !existingIds.has(n.id) : true,
    _backendWeight: n.weight || null,
    _dimBorder: dimBorder,
    _accent: accent,
  };
}

const EDGE_KEY_LIMIT = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER));
export function edgeKey(a, b) {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  if (lo >= 0 && hi < EDGE_KEY_LIMIT) return lo * EDGE_KEY_LIMIT + hi;
  return `${lo}_${hi}`;
}

export function buildEdgeState(e) {
  const lo = Math.min(e.from, e.to);
  const hi = Math.max(e.from, e.to);
  const role = resolveEdgeDominantRole(e);
  return {
    id: `${lo}_${hi}`,
    from: e.from,
    to: e.to,
    weight: e.weight || 1,
    collaboration_count: e.collaboration_count || null,
    collaborations: e.collaborations || [],
    songs: e.songs || [],
    dominantRole: role,
  };
}

function finalizeNodeRoleState() {
  const edgesByNode = new Map();
  const roleWeights = new Map();
  for (const n of State.graphNodes) {
    edgesByNode.set(n.id, []);
    roleWeights.set(n.id, {});
  }
  for (const e of State.graphEdges) {
    const r = e.dominantRole || "primary";
    const w = e.weight || 1;
    if (edgesByNode.has(e.from)) {
      edgesByNode.get(e.from).push(e);
      const m = roleWeights.get(e.from);
      m[r] = (m[r] || 0) + w;
    }
    if (edgesByNode.has(e.to)) {
      edgesByNode.get(e.to).push(e);
      const m = roleWeights.get(e.to);
      m[r] = (m[r] || 0) + w;
    }
  }

  for (const n of State.graphNodes) {
    const inc = edgesByNode.get(n.id) || [];
    n._topTracks = sortByPopularity(inc.flatMap((e) => e.collaborations || [])).slice(0, 5);
    n._rolesSet = new Set(inc.flatMap((e) => allRolesFromCollabs(e.collaborations)));
    n._totalCollabs = inc.reduce((s, e) => s + (e.collaboration_count || e.weight || 1), 0);

    if (n.isSeed) {
      n._dominantRole = "featured";
    } else {
      const counts = roleWeights.get(n.id) || {};
      let top = "primary",
        topC = 0;
      for (const [r, c] of Object.entries(counts))
        if (c > topC) {
          top = r;
          topC = c;
        }
      n._dominantRole = top;
    }

    const rs = roleStyle(n._dominantRole || "primary");
    const accent = n.isSeed ? COLOR.signal : rs.color;
    n._accent = accent;
    n._dimBorder = n.isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;
  }
}

export function finalizeGraphState(seedId, nameById, savedPositions, graph, isMerge) {
  if (seedId != null) {
    State.graphNodes.forEach((n) => {
      n.isSeed = n.id === seedId;
    });
  }

  setTruncation(graph);
  updateTruncationBanner();

  computeNodeSizes();
  finalizeNodeRoleState();
  invalidateColorCache();

  renderGraphA11yList();

  State._bfsAdj = null;

  if (!State.hasRendered) {
    initGraphOnCanvas();
    State.hasRendered = true;
  }

  if (!State.network) {
    initNetwork(seedId, nameById);
  } else if (isMerge) {
    mergeNetwork(nameById, savedPositions);
  } else {
    refreshNetwork(seedId, nameById, savedPositions);
  }

  if (!isMerge) {
    setSeed(seedId);
    hideArtistSidebar();
  }

  if (!isMerge) {
    updateStatus(graph);
  }
  els.heroInput.value = graph.seed || els.heroInput.value;
}

export function refreshNodeDimBorders() {
  for (const n of State.graphNodes) {
    const rs = roleStyle(n._dominantRole || "primary");
    const accent = n.isSeed ? COLOR.signal : rs.color;
    n._accent = accent;
    n._dimBorder = n.isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;
  }
}

export function computeNodeDominantRoles() {
  const roleWeights = new Map();
  for (const n of State.graphNodes) roleWeights.set(n.id, {});
  for (const e of State.graphEdges) {
    const r = e.dominantRole || "primary";
    const w = e.weight || 1;
    if (roleWeights.has(e.from)) {
      const m = roleWeights.get(e.from);
      m[r] = (m[r] || 0) + w;
    }
    if (roleWeights.has(e.to)) {
      const m = roleWeights.get(e.to);
      m[r] = (m[r] || 0) + w;
    }
  }
  for (const n of State.graphNodes) {
    if (n.isSeed) {
      n._dominantRole = "featured";
      continue;
    }
    const counts = roleWeights.get(n.id) || {};
    let top = "primary",
      topC = 0;
    for (const [r, c] of Object.entries(counts))
      if (c > topC) {
        top = r;
        topC = c;
      }
    n._dominantRole = top;
  }
}

export function cacheNodeCollaborations() {
  const edgesByNode = new Map();
  for (const n of State.graphNodes) edgesByNode.set(n.id, []);
  for (const e of State.graphEdges) {
    if (edgesByNode.has(e.from)) edgesByNode.get(e.from).push(e);
    if (edgesByNode.has(e.to)) edgesByNode.get(e.to).push(e);
  }
  for (const n of State.graphNodes) {
    const inc = edgesByNode.get(n.id) || [];
    const all = inc.flatMap((e) => e.collaborations || []);
    n._topTracks = sortByPopularity(all).slice(0, 5);
    n._rolesSet = new Set(inc.flatMap((e) => allRolesFromCollabs(e.collaborations)));
    n._totalCollabs = inc.reduce((s, e) => s + (e.collaboration_count || e.weight || 1), 0);
  }
}
