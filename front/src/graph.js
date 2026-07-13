// ════════════════════════════════════════════════════════════════════════════
// graph.js — Graph state management: replaceGraph, mergeGraph,
//            buildNodeState, buildEdgeState, finalizeGraphState,
//            computeNodeSizes, computeNodeDominantRoles, cacheNodeCollaborations
// ════════════════════════════════════════════════════════════════════════════
import { State, COLOR, setSeed, setNodes, setEdges, addNodes, addEdges, resetExpansionState, setTruncation } from "./state/state.js";
import { roleStyle, allRolesFromCollabs, sortByPopularity, isGeniusDefaultAvatar } from "./state/helpers.js";
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
  // SF-WEB-01: edgeKey() (not e.id) — a Set of the same numeric/string keys
  // computed for the incoming edges below, so membership checks below never
  // fall back to a full string-vs-string compare when a fast numeric one
  // will do. Doesn't touch buildEdgeState's own `.id` (still "lo_hi" —
  // depended on elsewhere as a DOM data-edge-id string).
  const existingEdgeKeys = new Set(State.graphEdges.map(e => edgeKey(e.from, e.to)));

  const nameById = {};
  State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
  graph.nodes.forEach(n => { nameById[n.id] = n.name || ""; });

  // SF-WEB-01: single pass over graph.nodes/graph.edges each (was a
  // separate .filter() + .map(), i.e. two passes) — same resulting set
  // (existingNodeIds/existingEdgeKeys are snapshotted once beforehand, same
  // as the old .filter() closures, so duplicate ids/pairs *within* the
  // incoming batch itself still both pass through, unchanged behaviour).
  // Централити убрана — обновлять здесь больше нечего для уже
  // существующих узлов (раньше подтягивали betweenness_normalised).
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

  // [SF-WEB-16] Front-guard: SF-API-07 already filters Genius's default
  // image server-side, but treat it as "no photo" here too in case an
  // unfiltered URL like it ever arrives — see isGeniusDefaultAvatar.
  const imageUrl = (n.image && !isGeniusDefaultAvatar(n.image)) ? n.image : "";

  return {
    id:               n.id,
    name:             n.name || "",
    imageUrl,
    geniusUrl:        n.url   || null,
    genres:           [],
    isSeed:           isSeed,
    _isNew:           existingIds ? !existingIds.has(n.id) : true,
    _backendWeight:   n.weight || null,
    _dimBorder:       dimBorder,        // Task 6: persisted here
    _accent:          accent,
  };
}

// SF-WEB-01: composite numeric edge-dedup key — lo*EDGE_KEY_LIMIT+hi is a
// unique integer for any pair of ids under EDGE_KEY_LIMIT, and comparing/
// hashing a number in a Set is cheaper than the template-string alloc
// (`${lo}_${hi}`) mergeGraph used to build per edge, per merge. Genius
// artist ids are nowhere near this range in practice, but rather than
// assume it we verify: both endpoints must fit under
// sqrt(Number.MAX_SAFE_INTEGER) so the composite itself can't exceed
// Number.MAX_SAFE_INTEGER (lo and hi both at the limit is the worst case —
// EDGE_KEY_LIMIT² is exactly the bound). Anything outside that range falls
// back to the original string key — still correct, just not the fast path —
// computed once per edge either way.
const EDGE_KEY_LIMIT = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER)); // ≈ 94,906,265

export function edgeKey(a, b) {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  if (lo >= 0 && hi < EDGE_KEY_LIMIT) return lo * EDGE_KEY_LIMIT + hi;
  return `${lo}_${hi}`;
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
