import { State, setGameMode, setNodes, setEdges } from "../state/state.js";
import { els } from "../dom/dom.js";
import { exitCompareMode } from "./compare-mode.js";

export function isGameModeActive() {
  return State.game.mode === true;
}

export function applyGameEngineOptions() {
  if (!isGameModeActive()) return;
  applyHoverOption(false);
  try {
    State.network.setOptions({ edges: { width: 1, selectionWidth: 1, hoverWidth: 0 } });
  } catch {}
}

function applyHoverOption(on) {
  try {
    State.network && State.network.setOptions({ interaction: { hover: on } });
  } catch {}
}

export function enterGameMode({ container, onNodeClick } = {}) {
  if (!els.network || !container) return;

  exitCompareMode({ silent: true });

  const home = isGameModeActive() ? State.game.homeParent : els.network.parentElement;
  if (els.network.parentElement !== container) container.appendChild(els.network);

  setGameMode(true, { clickRouter: onNodeClick || null, homeParent: home });

  applyGameEngineOptions();

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      try {
        State.network && State.network.redraw();
      } catch {}
    });
  }
}

export function exitGameMode() {
  if (!isGameModeActive() && !State.game.homeParent) return;

  const home = State.game.homeParent;
  setGameMode(false);
  applyHoverOption(true);
  try {
    if (State.nodesDS) State.nodesDS.clear();
    if (State.edgesDS) State.edgesDS.clear();
  } catch {}
  setNodes([]);
  setEdges([]);

  if (els.network && home && els.network.parentElement !== home) {
    home.appendChild(els.network);
  }
}

export function handleGameModeNodeClick(params) {
  if (!isGameModeActive()) return;
  const route = State.game.clickRouter;
  if (typeof route === "function") route(params);
}
