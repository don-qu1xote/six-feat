import { State, ROLE_ICON, MOTION, visAnimation } from "../state/state.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import {
  openGeniusPage,
  highlightEdgePair,
  selectNode,
  selectEdge,
  clearSelectedEdge,
  clearSelectedNode,
} from "../vis-adapter/index.js";
import { isSearchModalOpen, closeSearchModal, closeNodeSearch, closePathPanel } from "./modals.js";
import { searchArtist, deepenArtistConnections } from "../api/api.js";
import { showToast } from "./toast.js";
import { closeComparePanel } from "./compare-panel.js";
import { t, tPlural } from "../i18n/i18n.js";
import { fetchEdgeDetails } from "../api/analytics-client.js";
import { renderLoadingState, renderErrorState } from "./canvas-states.js";

function wrapRoleIconSidebar(roleIconUseString) {
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

function wrapRoleIconGraph(roleIconUseString) {
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

function computeRoleBreakdown(nodeId) {
  const breakdown = {};

  State.graphEdges.forEach((e) => {
    if (e.from === nodeId || e.to === nodeId) {
      const role = (e.dominantRole || "featured").toLowerCase();
      breakdown[role] = (breakdown[role] || 0) + 1;
    }
  });

  return breakdown;
}

function buildRoleChipsHTML(breakdown) {
  const entries = Object.entries(breakdown);
  if (!entries.length) {
    return `<span style="color:var(--mist);font-size:11px;">—</span>`;
  }
  return entries
    .map(([role, count]) => {
      const slug = role.replace(/[^a-z0-9]/g, "");
      const icon = wrapRoleIconSidebar(ROLE_ICON[slug] || ROLE_ICON.primary || "");
      return `<span class="sidebar-role-chip role-chip--${slug}" title="${escapeHtml(role)}"><span class="rbc-icon">${icon}</span><span class="rbc-count">${count}</span></span>`;
    })
    .join("");
}

function buildRoleBreakdownHTML(nodeId) {
  return buildRoleChipsHTML(computeRoleBreakdown(nodeId));
}

// [SF-API-23] Раскладка по ролям считается из того, что уже пришло с ребром,
// или из подгруженных треков, если панель их успела получить. Ждать сети ради
// одной плитки незачем: у ребра есть доминирующая роль и число треков, а это
// ровно то, что раскладка и показывала, пока треки не загрузились.
function computeEdgeRoleBreakdown(edge, collaborations) {
  const breakdown = {};
  const collabs = collaborations || [];
  if (collabs.length) {
    collabs.forEach((c) => {
      (c.roles || []).forEach((r) => {
        const role = r.toLowerCase();
        breakdown[role] = (breakdown[role] || 0) + 1;
      });
    });
    return breakdown;
  }
  const songs = edge.songs || [];
  const role = (edge.dominantRole || "featured").toLowerCase();
  breakdown[role] = songs.length || edge.collaboration_count || edge.weight || 0;
  return breakdown;
}

function buildEdgeRoleBreakdownHTML(edge, collaborations) {
  return buildRoleChipsHTML(computeEdgeRoleBreakdown(edge, collaborations));
}

function buildEdgeEndpointsHTML(edge, nameById) {
  return [edge.from, edge.to]
    .map((id) => {
      const n = State.graphNodes.find((x) => x.id === id);
      const name = n ? n.name : nameById[id] || "?";
      const avatar = n ? n.imageUrl || placeholderFor(name, n.isSeed) : placeholderFor(name, false);
      return `
      <div class="path-node-card" data-node-id="${id}" title="${escapeHtml(name)}" style="cursor:pointer;">
        <img class="path-node-avatar" src="${escapeHtml(avatar)}" data-fallback="${escapeHtml(placeholderFor(name, false))}" alt="" />
        <div class="path-node-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      </div>`;
    })
    .join("");
}

// [SF-API-24] Пути здесь никогда не искали. Плитка показывалась только для
// прямого соседа сида — от обхода в ширину брали ровно один бит («есть ли
// ребро nodeId—сид»), а любой результат длиннее двух узлов отбрасывали
// проверкой `path.length !== 2`. Поэтому вместе с клиентским обходом отсюда
// уходит не потребитель путей, а лишний вызов: ребро уже нарисовано на
// холсте, и спрашивать о нём сервер незачем — сайдбар открывается на каждый
// клик по узлу и рисуется синхронно, сетевой запрос заменил бы мгновенную
// отрисовку ожиданием ради факта, который лежит в State.graphEdges.
function getPathToSeed(nodeId) {
  if (State.currentSeedId == null || nodeId === State.currentSeedId) {
    return null;
  }

  const seedId = State.currentSeedId;
  const isDirectEdge = State.graphEdges.some(
    (e) => (e.from === nodeId && e.to === seedId) || (e.to === nodeId && e.from === seedId),
  );
  if (!isDirectEdge) return null;
  return { path: [nodeId, seedId], hops: 1 };
}

function buildPathTrackHTML(nodeId, pathInfo) {
  if (!pathInfo) return "";
  const { path } = pathInfo;

  const edgeByPair = new Map();
  State.graphEdges.forEach((e) => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    edgeByPair.set(`${lo}_${hi}`, e);
  });

  const parts = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    const n = State.graphNodes.find((x) => x.id === id);
    const name = n ? n.name : "?";
    const avatar = n ? n.imageUrl || placeholderFor(name, n.isSeed) : placeholderFor(name, false);
    const isCurrent = id === nodeId;
    parts.push(`
      <div class="path-node-card" data-node-id="${id}" title="${escapeHtml(name)}${isCurrent ? escapeHtml(t("sidebar.thisArtist")) : ""}" style="${isCurrent ? "cursor:default;border-color:var(--signal);" : "cursor:pointer;"}">
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
      parts.push(
        `<div class="path-edge-connector" data-edge-id="${edge?.id || `${lo}_${hi}`}" role="button" tabindex="0" title="${escapeHtml(roleWord)} · ${escapeHtml(tPlural("playlists.trackCount", trackCount))}">` +
          `<span class="path-edge-label role-chip--${roleSlug}">${icon} ${trackCount}</span>` +
          `</div>`,
      );
    }
  }
  return parts.join("");
}

function syncObjectActionBar(node) {
  if (!els.objectActionBar) return;

  if (els.objActionExpand) {
    els.objActionExpand.onclick = () => {
      showToast(t("sidebar.expandingToast", { name: node.name }), 1800, true);
      State._clickedNodeId = node.id;
      searchArtist(node.name, true, true);
    };
  }
  if (els.objActionDeepen) {
    // Бэкенд теперь всегда присылает deepen_available: true (Genius —
    // единственный источник графа), но проверка оставлена как защита
    // от будущих регрессий в контракте API.
    const deepenAvailable = node.deepenAvailable !== false;
    els.objActionDeepen.disabled = !deepenAvailable;
    els.objActionDeepen.title = deepenAvailable
      ? "Find more connections via Genius"
      : "This artist has no known Genius match yet — connect Genius in Settings to find more connections";
    els.objActionDeepen.onclick = deepenAvailable ? () => deepenArtistConnections(node.id) : null;
  }
  if (els.objActionFocus) {
    els.objActionFocus.onclick = () => {
      if (State.network) {
        State.network.focus(node.id, { scale: 1.2, animation: visAnimation(MOTION.flight) });
      }
    };
  }
  if (els.objActionGenius) {
    els.objActionGenius.onclick = () => openGeniusPage(node.id);
  }

  els.objectActionBar.hidden = false;
}

export function showArtistSidebar(nodeId) {
  const node = State.graphNodes.find((n) => n.id === nodeId);
  if (!node) return;

  if (isSearchModalOpen() && els.searchModal?.classList.contains("docked")) closeSearchModal();
  closeNodeSearch();

  closePathPanel();
  closeComparePanel();
  selectNode(nodeId);

  els.sidebarAvatar.src = node.imageUrl || placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.dataset.fallback = placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.alt = node.name;
  els.sidebarAvatar.classList.toggle("is-seed", !!node.isSeed);
  els.sidebarName.textContent = node.name;
  els.sidebarName.title = node.name;
  const collab = node._totalCollabs || node.totalWeight || 0;
  const expanded = State.expandedNodes.has(node.id) ? t("sidebar.expandedSuffix") : "";
  els.sidebarMeta.textContent = `${tPlural("sidebar.collabCount", collab)}${expanded}`;

  const tracks = node._topTracks || [];
  if (tracks.length) {
    els.sidebarTracks.innerHTML = tracks
      .map((track) => {
        const roles = track.roles || [];
        const mainR = roles[0] ? roles[0].toLowerCase().replace(/[^a-z0-9]/g, "") : "primary";
        const icon = wrapRoleIconSidebar(ROLE_ICON[mainR] || "");
        return `<div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(track.song || t("tooltip.untitled"))}</span>
        <span class="sidebar-track-role role-chip--${mainR}" title="${escapeHtml(roles[0] || "primary")}">${icon}</span>
      </div>`;
      })
      .join("");
  } else {
    els.sidebarTracks.innerHTML = `<div style="color:var(--mist);font-size:12px;">${escapeHtml(t("tooltip.noTracks"))}</div>`;
  }

  els.sidebarRoleBreakdownTile.style.display = "";
  els.sidebarRoleChips.innerHTML = buildRoleBreakdownHTML(nodeId);
  if (els.sidebarEndpointsTile) els.sidebarEndpointsTile.style.display = "none";

  const pathInfo = getPathToSeed(nodeId);
  els.sidebarPathTile.style.display = pathInfo ? "" : "none";
  els.sidebarPathTrack.innerHTML = buildPathTrackHTML(nodeId, pathInfo);

  if (pathInfo) {
    els.sidebarPathTrack.querySelectorAll(".path-node-card").forEach((card) => {
      const targetId = card.getAttribute("data-node-id");
      if (targetId == null || String(targetId) === String(nodeId)) return;
      card.addEventListener("click", () => {
        if (State.network) {
          State.network.focus(targetId, { scale: 1.2, animation: visAnimation(MOTION.flight) });
        }
        showArtistSidebar(targetId);
      });
    });

    els.sidebarPathTrack.querySelectorAll(".path-edge-connector[data-edge-id]").forEach((el) => {
      const onActivate = () => {
        const edgeId = el.getAttribute("data-edge-id");
        if (edgeId == null) return;
        highlightEdgePair(edgeId);
        showEdgeSidebarByPathEdgeId(edgeId, {});
      };
      el.addEventListener("click", onActivate);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      });
    });
  }

  els.artistSidebar.classList.add("show");
  els.companionPanel?.classList.add("show");

  syncObjectActionBar(node);
}

export function showEdgeSidebar(edgeId, nameById) {
  const edge = State.graphEdges.find((e) => e.id === edgeId);
  if (!edge) return;

  closePathPanel();
  closeComparePanel();

  const fromName =
    nameById[edge.from] || State.graphNodes.find((n) => n.id === edge.from)?.name || "?";
  const toName = nameById[edge.to] || State.graphNodes.find((n) => n.id === edge.to)?.name || "?";
  const role = edge.dominantRole || "primary";
  const icon = wrapRoleIconSidebar(ROLE_ICON[role] || "");

  els.sidebarAvatar.src = placeholderFor(`${fromName[0]}${toName[0]}`, false);
  els.sidebarAvatar.dataset.fallback = placeholderFor(`${fromName[0]}${toName[0]}`, false);
  els.sidebarAvatar.alt = "";
  els.sidebarAvatar.classList.remove("is-seed");
  els.sidebarName.textContent = `${fromName} × ${toName}`;
  els.sidebarMeta.innerHTML = `${escapeHtml(tPlural("tooltip.sharedTracks", edge.weight))} · <span title="${escapeHtml(role)}">${icon}</span>`;

  const songs = edge.songs || [];
  const roleSlug = role.toLowerCase().replace(/[^a-z0-9]/g, "");

  const renderCollaborations = (collabs) => {
    els.sidebarTracks.innerHTML = collabs
      .map((c) => {
        const roles = c.roles || [];
        const chips = roles
          .map((r) => {
            const sl = r.toLowerCase().replace(/[^a-z0-9]/g, "");
            const icon = wrapRoleIconSidebar(ROLE_ICON[sl] || "");
            return `<span class="sidebar-track-role role-chip--${sl}" title="${escapeHtml(r)}">${icon}</span>`;
          })
          .join(" ");
        return `<div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(c.song || t("tooltip.untitled"))}</span>
        <span style="display:flex;gap:3px;flex-wrap:wrap">${chips}</span>
      </div>`;
      })
      .join("");
  };

  if (songs.length) {
    // Ответ поиска пути несёт треки на рёбрах осознанно (SF-API-23 их там не
    // трогает) — значит спрашивать сервер не о чем.
    els.sidebarTracks.innerHTML = songs
      .map(
        (title) => `
      <div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(typeof title === "string" ? title : title.song || title.title || t("tooltip.untitled"))}</span>
        <span class="sidebar-track-role role-chip--${roleSlug}" title="${escapeHtml(role)}">${icon}</span>
      </div>`,
      )
      .join("");
  } else {
    // [SF-API-23] Ребро графа списка треков не несёт — запрашиваем его на
    // раскрытии. Спиннер и ошибка — общие состояния SF-WEB-19, а не свои:
    // панель ничем не особеннее остальных.
    const requestedEdgeId = edge.id;
    renderLoadingState(els.sidebarTracks, t("sidebar.loadingTracks"));

    fetchEdgeDetails(edge.from, edge.to)
      .then((result) => {
        // Пока ходили в сеть, пользователь мог открыть другое ребро.
        if (State.selectedEdgeId !== requestedEdgeId) return;
        if (result.error) {
          renderErrorState(els.sidebarTracks, t("sidebar.tracksFailed"), () =>
            showEdgeSidebar(requestedEdgeId, nameById),
          );
          return;
        }
        if (!result.collaborations.length) {
          els.sidebarTracks.innerHTML = `<div style="color:var(--mist);font-size:12px;">${escapeHtml(t("tooltip.noTracks"))}</div>`;
          return;
        }
        renderCollaborations(result.collaborations);
        els.sidebarRoleChips.innerHTML = buildEdgeRoleBreakdownHTML(edge, result.collaborations);
      })
      .catch(() => {
        if (State.selectedEdgeId !== requestedEdgeId) return;
        renderErrorState(els.sidebarTracks, t("sidebar.tracksFailed"), () =>
          showEdgeSidebar(requestedEdgeId, nameById),
        );
      });
  }

  els.sidebarPathTile.style.display = "none";

  if (els.sidebarEndpointsTile && els.sidebarEndpointsTrack) {
    els.sidebarEndpointsTile.style.display = "";
    els.sidebarEndpointsTrack.innerHTML = buildEdgeEndpointsHTML(edge, nameById);
    const endpointIds = [edge.from, edge.to];
    els.sidebarEndpointsTrack.querySelectorAll(".path-node-card").forEach((card, i) => {
      const targetId = endpointIds[i];
      card.addEventListener("click", () => {
        if (State.network) {
          State.network.focus(targetId, { scale: 1.2, animation: visAnimation(MOTION.flight) });
        }
        showArtistSidebar(targetId);
      });
    });
  }
  els.sidebarRoleBreakdownTile.style.display = "";
  els.sidebarRoleChips.innerHTML = buildEdgeRoleBreakdownHTML(edge);

  els.artistSidebar.classList.add("show");
  els.companionPanel?.classList.add("show");
  if (els.objectActionBar) els.objectActionBar.hidden = true;
  selectEdge(edgeId);
}

export function hideArtistSidebar() {
  els.artistSidebar.classList.remove("show");
  els.companionPanel?.classList.remove("show");
  closeComparePanel();
  if (els.objectActionBar) els.objectActionBar.hidden = true;
  clearSelectedEdge();
  clearSelectedNode();
}

export function showEdgeSidebarByPathEdgeId(edgeId, nameById) {
  let resolvedId = edgeId;
  if (!State.graphEdges.some((e) => e.id === edgeId)) {
    const match = State.graphEdges.find((e) => {
      const lo = Math.min(e.from, e.to);
      const hi = Math.max(e.from, e.to);
      return `${lo}_${hi}` === edgeId;
    });
    if (match) resolvedId = match.id;
  }
  showEdgeSidebar(resolvedId, nameById);
}
