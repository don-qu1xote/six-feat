// ════════════════════════════════════════════════════════════════════════════
// graph.js — Graph state management: replaceGraph, mergeGraph,
//            buildNodeState, buildEdgeState, finalizeGraphState,
//            computeNodeSizes, computeNodeDominantRoles, cacheNodeCollaborations
// ════════════════════════════════════════════════════════════════════════════
import { State, COLOR, setSeed, setNodes, setEdges, addNodes, addEdges, resetExpansionState, setTruncation } from "./state/state.js";
import { roleStyle, allRolesFromCollabs, sortByPopularity } from "./state/helpers.js";
import { resolveEdgeDominantRole, computeNodeSizes, initGraphOnCanvas, initNetwork, refreshNetwork, mergeNetwork, nodeVisual, edgeVisual, invalidateColorCache } from "./vis-adapter/index.js";
import { els } from "./dom/dom.js";
import { hideArtistSidebar } from "./ui/sidebar.js";
import { updateStatus, updateTruncationBanner } from "./ui/canvas-controls.js";
import { renderGraphA11yList } from "./ui/index.js";

export function replaceGraph(graph) {
  const seedId = graph.seed_id ?? (graph.nodes[0]?.id);

  const savedPositions = State.network ? State.network.getPositions() : {};
  const nameById = {};
  graph.nodes.forEach(n => { nameById[n.id] = n.name || ""; });

  resetExpansionState();

  const existingIds = new Set(State.graphNodes.map(n => n.id));
  setNodes(graph.nodes.map(n => buildNodeState(n, seedId, existingIds, graph)));
  setEdges(graph.edges.map(e => buildEdgeState(e)));

  finalizeGraphState(seedId, nameById, savedPositions, graph, false);
}

// ════════════════════════════════════════════════════════════════════════════
// MERGE GRAPH
// ════════════════════════════════════════════════════════════════════════════

export function mergeGraph(graph) {
  const expandedId = graph.seed_id ?? (graph.nodes[0]?.id);

  const savedPositions = State.network ? State.network.getPositions() : {};

  const existingNodeIds  = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map(e => e.id));

  const nameById = {};
  State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
  graph.nodes.forEach(n => { nameById[n.id] = n.name || ""; });

  // Централити убрана — обновлять здесь больше нечего для уже
  // существующих узлов (раньше подтягивали betweenness_normalised).
  addNodes(
    graph.nodes
      .filter(n => !existingNodeIds.has(n.id))
      .map(n => buildNodeState(n, null, existingNodeIds, graph))
  );

  addEdges(
    graph.edges
      .filter(e => !existingEdgeKeys.has(`${Math.min(e.from, e.to)}_${Math.max(e.from, e.to)}`))
      .map(e => buildEdgeState(e))
  );

  State.expandedNodes.add(expandedId);
  State.lastExpandedId = expandedId;

  // Записываем родителя expand-дерева: кликнутая нода = _clickedNodeId
  const expandedNode = State.graphNodes.find(n => n.id === expandedId);
  if (expandedNode && expandedNode._expandParent == null) {
    expandedNode._expandParent = State._clickedNodeId ?? State.currentSeedId ?? null;
  }

  finalizeGraphState(State.currentSeedId, nameById, savedPositions, graph, true);
}

// ─── Node / edge state constructors ────────────────────────────────────────

// Task 6: _dimBorder persisted onto graphNode state
export function buildNodeState(n, seedId, existingIds, graph) {
  const isSeed   = (n.id === seedId);
  const domRole  = "primary"; // computed later
  const rs       = roleStyle(domRole);
  const accent   = isSeed ? COLOR.signal : rs.color;
  const dimBorder = isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;

  return {
    id:               n.id,
    name:             n.name || "",
    imageUrl:         n.image || "",
    geniusUrl:        n.url   || null,
    genres:           [],
    isSeed:           isSeed,
    _isNew:           existingIds ? !existingIds.has(n.id) : true,
    _backendWeight:   n.weight || null,
    _dimBorder:       dimBorder,        // Task 6: persisted here
    _accent:          accent,
  };
}

export function buildEdgeState(e) {
  const lo   = Math.min(e.from, e.to);
  const hi   = Math.max(e.from, e.to);
  const role = resolveEdgeDominantRole(e);
  return {
    id:                  `${lo}_${hi}`,
    from:                e.from,
    to:                  e.to,
    weight:              e.weight || 1,
    collaboration_count: e.collaboration_count || null,
    collaborations:      e.collaborations || [],
    // Task 1: path endpoint returns songs[] instead of collaborations[]
    songs:               e.songs || [],
    dominantRole:        role
  };
}

// ─── Shared finaliser ───────────────────────────────────────────────────────

// Fused replacement for cacheNodeCollaborations + computeNodeDominantRoles +
// refreshNodeDimBorders on finalizeGraphState's hot path: those walked
// graphEdges twice and graphNodes three times combined. A node's dominant
// role only depends on its own accumulated role weights (no cross-node
// dependency), so dimBorder can be derived right after the role is picked in
// the same node iteration — preserving "dominant roles before dimBorder"
// while collapsing everything into one edge pass + one node pass. The
// standalone exports below are untouched (still used individually by
// ui/path-result.js and covered by graph.test.js).
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
    n._topTracks    = sortByPopularity(inc.flatMap(e => e.collaborations || [])).slice(0, 5);
    n._rolesSet     = new Set(inc.flatMap(e => allRolesFromCollabs(e.collaborations)));
    n._totalCollabs = inc.reduce((s, e) => s + (e.collaboration_count || e.weight || 1), 0);

    if (n.isSeed) {
      n._dominantRole = "featured";
    } else {
      const counts = roleWeights.get(n.id) || {};
      let top = "primary", topC = 0;
      for (const [r, c] of Object.entries(counts)) if (c > topC) { top = r; topC = c; }
      n._dominantRole = top;
    }

    const rs = roleStyle(n._dominantRole || "primary");
    const accent = n.isSeed ? COLOR.signal : rs.color;
    n._accent    = accent;
    n._dimBorder = n.isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;
  }
}

export function finalizeGraphState(seedId, nameById, savedPositions, graph, isMerge) {
  if (seedId != null) {
    State.graphNodes.forEach(n => { n.isSeed = (n.id === seedId); });
  }

  // IDEA-50: update the truncation flag/counts from *this* response and
  // refresh the banner — covers both a fresh replaceGraph and a merge
  // (e.g. "Show more collaborations" re-fetching at a bigger limit).
  setTruncation(graph);
  updateTruncationBanner();

  computeNodeSizes();
  finalizeNodeRoleState();
  // Инвалидируем кэш цветов — граф изменился.
  invalidateColorCache();

  // F-43: keep the sr-only accessible node/neighbour list panel in sync with
  // State.graphNodes/graphEdges every time the graph is (re)built or merged.
  renderGraphA11yList();

  // Дешёвый dirty-флаг вместо graphHash(): здесь граф уже гарантированно
  // изменился (replaceGraph/mergeGraph только что пересобрали nodes/edges),
  // так что просто сбрасываем adj-кэш вместо пересчёта O(E log E) хэша.
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
    refreshNetwork(nameById, savedPositions);
  }

  if (!isMerge) {
    setSeed(seedId);
    hideArtistSidebar();
  }

  // Баг: seed-card в левом нижнем углу — при expand (isMerge=true) `graph`
  // это ответ по РАСКРЫВАЕМОМУ узлу, а не по исходному seed. updateStatus
  // раньше вызывался с этим graph всегда, из-за чего graph.seed (имя
  // раскрытого артиста) перезаписывало имя seed-карточки поверх настоящего
  // seed — при этом аватар оставался верным (он берётся по
  // State.currentSeedId, а не из graph), создавая рассинхрон "имя сменилось,
  // фото — нет". При expand карточку сида вообще не трогаем: она должна
  // показывать исходный seed независимо от того, что раскрывается.
  if (!isMerge) {
    updateStatus(graph);
  }
  els.heroInput.value = graph.seed || els.heroInput.value;
}

// Task 6: keep _dimBorder in sync after role computation
export function refreshNodeDimBorders() {
  for (const n of State.graphNodes) {
    const rs = roleStyle(n._dominantRole || "primary");
    const accent = n.isSeed ? COLOR.signal : rs.color;
    n._accent    = accent;
    n._dimBorder = n.isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;
  }
}

export function computeNodeDominantRoles() {
  // O(N+E): один проход по рёбрам, накапливаем веса по ролям.
  const roleWeights = new Map();  // nodeId → {role: weight}
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
    if (n.isSeed) { n._dominantRole = "featured"; continue; }
    const counts = roleWeights.get(n.id) || {};
    let top = "primary", topC = 0;
    for (const [r, c] of Object.entries(counts)) if (c > topC) { top = r; topC = c; }
    n._dominantRole = top;
  }
}

export function cacheNodeCollaborations() {
  // Строим adjacency-индекс один раз за O(E) вместо O(N×E) фильтрации.
  const edgesByNode = new Map();
  for (const n of State.graphNodes) edgesByNode.set(n.id, []);
  for (const e of State.graphEdges) {
    if (edgesByNode.has(e.from)) edgesByNode.get(e.from).push(e);
    if (edgesByNode.has(e.to))   edgesByNode.get(e.to).push(e);
  }
  for (const n of State.graphNodes) {
    const inc = edgesByNode.get(n.id) || [];
    const all = inc.flatMap(e => e.collaborations || []);
    // Ранжируем по popularity (Genius stats.pageviews, см. graph_handler.cpp)
    // по убыванию, стабильно — затем берём топ-5.
    n._topTracks    = sortByPopularity(all).slice(0, 5);
    n._rolesSet     = new Set(inc.flatMap(e => allRolesFromCollabs(e.collaborations)));
    n._totalCollabs = inc.reduce((s, e) => s + (e.collaboration_count || e.weight || 1), 0);
  }
}
