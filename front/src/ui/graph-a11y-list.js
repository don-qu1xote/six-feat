import { State, MOTION, visAnimation } from "../state/state.js";
import { els } from "../dom/dom.js";
import { escapeHtml } from "../state/helpers.js";
import { setFocus } from "../vis-adapter/index.js";
import { showArtistSidebar } from "./sidebar.js";

const ROLE_NAME = {
  featured: "featured",
  producer: "producer",
  writer: "writer",
  primary: "collaborator",
};

let selectedNodeId = null;

function edgesForNode(nodeId) {
  return State.graphEdges.filter((e) => e.from === nodeId || e.to === nodeId);
}

function selectNode(nodeId) {
  if (!State.graphNodes.some((n) => n.id === nodeId)) return;

  if (State.network) {
    State.network.focus(nodeId, { scale: 1.5, animation: visAnimation(MOTION.xxslow) });
  }
  setFocus(nodeId);
  showArtistSidebar(nodeId);

  selectedNodeId = nodeId;
  renderNeighborList();
  markActiveNode();
}

function markActiveNode() {
  if (!els.graphA11yNodeList) return;
  els.graphA11yNodeList
    .querySelectorAll("button[aria-current]")
    .forEach((b) => b.removeAttribute("aria-current"));
  const active = els.graphA11yNodeList.querySelector(`button[data-node-id="${selectedNodeId}"]`);
  if (active) active.setAttribute("aria-current", "true");
}

function renderNeighborList() {
  const list = els.graphA11yNeighborList;
  const heading = els.graphA11yNeighborsHeading;
  if (!list) return;

  const node = State.graphNodes.find((n) => n.id === selectedNodeId);
  if (!node) {
    list.innerHTML = "";
    if (heading) heading.textContent = "Connections";
    return;
  }

  if (heading) heading.textContent = `Connections of ${node.name}`;

  const edges = edgesForNode(node.id);
  if (!edges.length) {
    list.innerHTML = `<li>No connections</li>`;
    return;
  }

  list.innerHTML = edges
    .map((e) => {
      const otherId = e.from === node.id ? e.to : e.from;
      const other = State.graphNodes.find((n) => n.id === otherId);
      const name = other ? other.name : `Artist #${otherId}`;
      const role = ROLE_NAME[e.dominantRole] || ROLE_NAME.primary;
      return `<li><button type="button" data-node-id="${otherId}">${escapeHtml(name)} — ${escapeHtml(role)}</button></li>`;
    })
    .join("");

  list.querySelectorAll("button[data-node-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectNode(Number(btn.getAttribute("data-node-id"))));
  });
}

export function renderGraphA11yList() {
  const list = els.graphA11yNodeList;
  if (!list) return;

  if (selectedNodeId != null && !State.graphNodes.some((n) => n.id === selectedNodeId)) {
    selectedNodeId = null;
  }

  list.innerHTML = State.graphNodes
    .map((n) => {
      const count = edgesForNode(n.id).length;
      const label = `${n.name}${n.isSeed ? ", seed artist" : ""}, ${count} connection${count === 1 ? "" : "s"}`;
      return `<li><button type="button" data-node-id="${n.id}">${escapeHtml(label)}</button></li>`;
    })
    .join("");

  list.querySelectorAll("button[data-node-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectNode(Number(btn.getAttribute("data-node-id"))));
  });

  if (selectedNodeId != null) {
    renderNeighborList();
    markActiveNode();
  } else {
    renderNeighborList();
  }
}
