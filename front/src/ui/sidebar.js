// ════════════════════════════════════════════════════════════════════════════
// ui/sidebar.js — Artist sidebar (Tracks / Role breakdown / "1 hop from
//                 seed") and edge sidebar (shared tracks between two artists).
//
// Artist sidebar scope: Tracks / Role breakdown / "1 hop from seed" only
// (centrality removed entirely; "Roles in this graph" section removed).
// ════════════════════════════════════════════════════════════════════════════
import { State, ROLE_ICON } from "../state/state.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { openGeniusPage, highlightEdgePair, selectEdge, clearSelectedEdge } from "../vis-adapter/index.js";
import { bfsPath } from "../api/analytics-client.js";
import { isSearchModalOpen, closeSearchModal, closeNodeSearch } from "./modals.js";

// ════════════════════════════════════════════════════════════════════════════
// Helpers: Wrap ROLE_ICON's <use> element in proper <svg> containers
// ════════════════════════════════════════════════════════════════════════════
function wrapRoleIconSidebar(roleIconUseString) {
  // For sidebar, role chips: larger 24×24
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

function wrapRoleIconGraph(roleIconUseString) {
  // For graph tooltips, edge displays: compact 20×20
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

// ════════════════════════════════════════════════════════════════════════════
// ТЗ-F: Helper functions for enhanced artist sidebar
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compute aggregated role breakdown for a node: count edges by dominant role.
 * Returns { featured: N, producer: M, writer: K, ... }
 */
function computeRoleBreakdown(nodeId) {
  const breakdown = {};

  State.graphEdges.forEach(e => {
    if (e.from === nodeId || e.to === nodeId) {
      const role = (e.dominantRole || "featured").toLowerCase();
      breakdown[role] = (breakdown[role] || 0) + 1;
    }
  });

  return breakdown;
}

/**
 * Build role-breakdown chips reusing the exact same visual language as the
 * existing role-chip system (.sidebar-role-chip + role-chip--* colour
 * modifiers). Minimal pill: icon + count only, no role word — the colour
 * + icon already identify the role, the word was redundant clutter.
 * 
 * FIX #4: Wrapped icon and count in separate spans for proper flex alignment
 */
function buildRoleBreakdownHTML(nodeId) {
  const breakdown = computeRoleBreakdown(nodeId);
  const entries = Object.entries(breakdown);
  if (!entries.length) {
    return `<span style="color:var(--mist);font-size:11px;">—</span>`;
  }
  return entries.map(([role, count]) => {
    const slug = role.replace(/[^a-z0-9]/g, "");
    const icon = wrapRoleIconSidebar(ROLE_ICON[slug] || ROLE_ICON.primary || "");
    return `<span class="sidebar-role-chip role-chip--${slug}" title="${escapeHtml(role)}"><span class="rbc-icon">${icon}</span><span class="rbc-count">${count}</span></span>`;
  }).join("");
}

/**
 * Find the direct (1-hop) connection from nodeId to seed, if one exists.
 * Sidebar scope was reduced to Tracks / Role breakdown / "1 hop from seed"
 * only — this section now shows exclusively when the artist is a DIRECT
 * neighbour of the seed, not an arbitrary N-hop BFS path. For anything
 * further than 1 hop the section is simply omitted (use the six-degrees
 * path panel for longer paths).
 * Returns { path, hops: 1 } or null.
 */
function getPathToSeed(nodeId) {
  if (State.currentSeedId == null || nodeId === State.currentSeedId) {
    return null;
  }

  const path = bfsPath(nodeId, State.currentSeedId);
  if (!path || path.length !== 2) return null; // ровно 1 хоп: [node, seed]

  return { path, hops: 1 };
}

/**
 * Build the "connection to seed" chain, reusing the exact same horizontal
 * card-track component already used for the six-degrees path finder
 * (.path-chain-container / .path-chain-track / .path-node-card /
 * .path-node-avatar / .path-node-name) so it looks native to the app
 * instead of introducing a new, unstyled pattern.
 *
 * ТЗ-207: the connector between cards now reuses the same
 * .path-edge-connector / .path-edge-label role-pill used by the hop chain
 * (ТЗ-205) instead of a plain "→" text arrow — one visual language for
 * "path" across hop-chain, sidebar path-to-seed, and (eventually) the
 * canvas itself, all keyed off the same role-chip-- colour system.
 */
function buildPathToSeedHTML(nodeId, pathInfo) {
  if (!pathInfo) return "";
  const { path } = pathInfo;

  // Edge lookup so the connector pill between two nodes can show the real
  // dominant role / track count, same data source as renderHopChain.
  const edgeByPair = new Map();
  State.graphEdges.forEach(e => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    edgeByPair.set(`${lo}_${hi}`, e);
  });

  const parts = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    const n = State.graphNodes.find(x => x.id === id);
    const name = n ? n.name : "?";
    const avatar = n ? (n.imageUrl || placeholderFor(name, n.isSeed)) : placeholderFor(name, false);
    const isCurrent = id === nodeId;
    parts.push(`
      <div class="path-node-card" data-node-id="${id}" title="${escapeHtml(name)}${isCurrent ? " (this artist)" : ""}" style="${isCurrent ? "cursor:default;border-color:var(--signal);" : "cursor:pointer;"}">
        <img class="path-node-avatar" src="${escapeHtml(avatar)}" data-fallback="${escapeHtml(placeholderFor(name, false))}" alt="" />
        <div class="path-node-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      </div>`);

    if (i < path.length - 1) {
      const nextId = path[i + 1];
      const lo = Math.min(id, nextId);
      const hi = Math.max(id, nextId);
      const edge = edgeByPair.get(`${lo}_${hi}`);
      const role = (edge?.dominantRole || edge?.dominant_role || "primary").toLowerCase();
      const roleSlug = role.replace(/[^a-z0-9]/g, "");
      const icon = wrapRoleIconGraph(ROLE_ICON[role] || "");
      const trackCount = edge?.weight ?? 0;
      const roleWord = role !== "primary" ? role : "collab";
      // Минимальный вид пилюли: только иконка роли + число треков —
      // слово роли убрано (цвет + иконка уже её идентифицируют), title
      // на контейнере по-прежнему даёт полный текст при наведении.
      parts.push(
        `<div class="path-edge-connector" data-edge-id="${edge?.id || `${lo}_${hi}`}" role="button" tabindex="0" title="${escapeHtml(roleWord)} · ${trackCount} track${trackCount === 1 ? "" : "s"}">` +
        `<span class="path-edge-label role-chip--${roleSlug}">${icon} ${trackCount}</span>` +
        `</div>`
      );
    }
  }
  const cards = parts.join("");

  return `
    <div>
      <div class="sidebar-section-label">1 hop from seed</div>
      <div class="path-chain-container">
        <div class="path-chain-fade path-chain-fade--left"></div>
        <div class="path-chain-track">${cards}</div>
        <div class="path-chain-fade path-chain-fade--right"></div>
      </div>
    </div>
  `;
}

// Централити убрана по запросу — buildCentralityIndicator() и "Network
// importance" плитка больше не существуют. betweennessGlow на графе тоже
// удалён (см. vis-adapter/render.js).

// ════════════════════════════════════════════════════════════════════════════
// Main artist sidebar function — expanded with ТЗ-F enhancements
// ════════════════════════════════════════════════════════════════════════════

export function showArtistSidebar(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;

  // Докнутый быстрый поиск/"Find on map" и сайдбар претендуют на один и
  // тот же правый верхний угол канвы (см. .search-modal.docked/
  // .node-search-overlay) — в отличие от path-panel (который намеренно
  // остаётся открытым, см. ниже), закрываем их при открытии сайдбара.
  if (isSearchModalOpen() && els.searchModal?.classList.contains("docked")) closeSearchModal();
  closeNodeSearch();

  // Task 4: path panel stays open (no longer force-closes it)
  clearSelectedEdge();

  els.sidebarAvatar.src = node.imageUrl || placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.dataset.fallback = placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.alt = node.name;
  els.sidebarName.textContent = node.name;
  els.sidebarName.title = node.name;  // native tooltip when ellipsis-truncated

  const collab   = node._totalCollabs || node.totalWeight || 0;
  const expanded = State.expandedNodes.has(node.id) ? " · expanded ✓" : "";
  els.sidebarMeta.textContent = `${collab} collab${collab === 1 ? "" : "s"}${expanded}`;

  // ---- Top tracks ----
  const tracks = node._topTracks || [];
  if (tracks.length) {
    els.sidebarTracks.innerHTML = tracks.map(t => {
      const roles = t.roles || [];
      const mainR = roles[0] ? roles[0].toLowerCase().replace(/[^a-z0-9]/g, "") : "primary";
      const icon  = wrapRoleIconSidebar(ROLE_ICON[mainR] || "");
      // Минимальный вид: только цветная иконка роли, без слова — title
      // на самой пилюле по-прежнему даёт название роли при наведении.
      return `<div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(t.song || "Untitled")}</span>
        <span class="sidebar-track-role role-chip--${mainR}" title="${escapeHtml(roles[0] || "primary")}">${icon}</span>
      </div>`;
    }).join("");
  } else {
    els.sidebarTracks.innerHTML = `<div style="color:var(--mist);font-size:12px;">No track data.</div>`;
  }

  // ---- Roles set removed — sidebar scope reduced to Tracks / Role
  // breakdown / "1 hop from seed" only (см. ниже). els.sidebarRoles больше
  // не заполняется; сама плитка скрыта в разметке (index.html).

  // ---- ТЗ-F / ТЗ-206 / ТЗ-207: Role breakdown / Path to seed — each
  // rendered as its own .bento-tile occupying a named grid area in
  // .sidebar-body (rolebreakdown / path). Tiles are created once and
  // reused across calls (matches the tracks tile, which is static markup)
  // so repeated showArtistSidebar() calls don't thrash the DOM.
  const sidebarBody = els.artistSidebar.querySelector(".sidebar-body");
  if (sidebarBody) {
    const geniusBtn = sidebarBody.querySelector(".sidebar-genius-btn");

    function ensureTile(id) {
      let tile = sidebarBody.querySelector(`#${id}`);
      if (!tile) {
        tile = document.createElement("div");
        tile.id = id;
        tile.className = "bento-tile bento-tile--md";
        if (geniusBtn) geniusBtn.parentNode.insertBefore(tile, geniusBtn);
        else sidebarBody.appendChild(tile);
      }
      return tile;
    }

    const roleBreakdownTile = ensureTile("sidebar-rolebreakdown-tile");
    roleBreakdownTile.style.display = "";
    roleBreakdownTile.innerHTML =
      `<div class="sidebar-section-label">Role breakdown</div>` +
      `<div class="sidebar-role-chips">${buildRoleBreakdownHTML(nodeId)}</div>`;

    const pathInfo = getPathToSeed(nodeId);
    const pathTile = ensureTile("sidebar-path-tile");
    const pathToSeedHtml = buildPathToSeedHTML(nodeId, pathInfo);
    pathTile.innerHTML = pathToSeedHtml;
    pathTile.style.display = pathInfo ? "" : "none";

    // Path-chain cards are clickable (except the current node) — jump the
    // sidebar to whichever artist was clicked, same interaction as
    // node-search results.
    if (pathInfo) {
      pathTile.querySelectorAll(".path-node-card").forEach(card => {
        const targetId = card.getAttribute("data-node-id");
        if (targetId == null || String(targetId) === String(nodeId)) return;
        card.addEventListener("click", () => {
          if (State.network) {
            State.network.focus(targetId, { scale: 1.2, animation: { duration: 400, easingFunction: "easeInOutQuad" } });
          }
          showArtistSidebar(targetId);
        });
      });

      // ТЗ-207: connector pills (role/track-count) between path cards open
      // the edge sidebar for that hop, same interaction as the hop-chain's
      // connector pills (ТЗ-205) — one shared behaviour for "path" UI.
      pathTile.querySelectorAll(".path-edge-connector[data-edge-id]").forEach(el => {
        const onActivate = () => {
          const edgeId = el.getAttribute("data-edge-id");
          if (edgeId == null) return;
          highlightEdgePair(edgeId);
          showEdgeSidebarByPathEdgeId(edgeId, {});
        };
        el.addEventListener("click", onActivate);
        el.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
        });
      });
    }
  }

  // ---- Genius button (unchanged) ----
  els.sidebarGenius.style.display = "";
  els.sidebarGenius.onclick = () => openGeniusPage(nodeId);
  els.artistSidebar.classList.add("show");
}

export function showEdgeSidebar(edgeId, nameById) {
  const edge = State.graphEdges.find(e => e.id === edgeId);
  if (!edge) return;

  const fromName = nameById[edge.from] || State.graphNodes.find(n => n.id === edge.from)?.name || "?";
  const toName   = nameById[edge.to]   || State.graphNodes.find(n => n.id === edge.to)?.name   || "?";
  const role     = edge.dominantRole || "primary";
  const icon     = wrapRoleIconSidebar(ROLE_ICON[role] || "");

  els.sidebarAvatar.src = placeholderFor(`${fromName[0]}${toName[0]}`, false);
  els.sidebarAvatar.dataset.fallback = placeholderFor(`${fromName[0]}${toName[0]}`, false);
  els.sidebarAvatar.alt = "";
  els.sidebarName.textContent = `${fromName} × ${toName}`;
  // Минимальный вид: без текстового слова роли в мете — иконка достаточно
  // информативна, полное название роли доступно через title.
  els.sidebarMeta.innerHTML =
    `${edge.weight} shared track${edge.weight === 1 ? "" : "s"} · <span title="${escapeHtml(role)}">${icon}</span>`;

  const collabs = edge.collaborations || [];
  if (collabs.length) {
    els.sidebarTracks.innerHTML = collabs.map(c => {
      const roles = c.roles || [];
      const chips = roles.map(r => {
        const sl = r.toLowerCase().replace(/[^a-z0-9]/g, "");
        const icon = wrapRoleIconSidebar(ROLE_ICON[sl] || "");
        return `<span class="sidebar-track-role role-chip--${sl}" title="${escapeHtml(r)}">${icon}</span>`;
      }).join(" ");
      return `<div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(c.song || "Untitled")}</span>
        <span style="display:flex;gap:3px;flex-wrap:wrap">${chips}</span>
      </div>`;
    }).join("");
  } else {
    els.sidebarTracks.innerHTML = `<div style="color:var(--mist);font-size:12px;">No track data.</div>`;
  }

  // ТЗ-206/207: hide the role-breakdown/path bento tiles for edge view —
  // they only make sense for a single artist, not an edge. (Centrality
  // tile removed entirely, see above.)
  ["sidebar-rolebreakdown-tile", "sidebar-path-tile"].forEach(id => {
    const tile = els.artistSidebar.querySelector(`#${id}`);
    if (tile) tile.style.display = "none";
  });

  els.sidebarGenius.style.display = "none";
  els.artistSidebar.classList.add("show");
  // IDEA-40: клик по ребру закрепляет выбор (persistent), а не только
  // временную hover-подсветку — иначе уход курсора с ребра откатывал бы
  // подсветку кликнутого ребра (см. selectEdge в vis-adapter/highlight.js).
  selectEdge(edgeId);
}

export function hideArtistSidebar() {
  els.artistSidebar.classList.remove("show");
  clearSelectedEdge();
}

// ТЗ-205: hop-chain edge ids may come from the path API response (which can
// use "lo_hi" synthetic keys not yet present in State.graphEdges if the
// path merge hasn't landed that edge under the same key) — fall back to a
// pair-key lookup against State.graphEdges before calling showEdgeSidebar,
// so the click always resolves to a real edge if one exists on canvas.
export function showEdgeSidebarByPathEdgeId(edgeId, nameById) {
  let resolvedId = edgeId;
  if (!State.graphEdges.some(e => e.id === edgeId)) {
    const match = State.graphEdges.find(e => {
      const lo = Math.min(e.from, e.to);
      const hi = Math.max(e.from, e.to);
      return `${lo}_${hi}` === edgeId;
    });
    if (match) resolvedId = match.id;
  }
  showEdgeSidebar(resolvedId, nameById);
}
