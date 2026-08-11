import { State } from "../state/state.js";
import { els, $ } from "../dom/dom.js";
import { clearPathHighlight } from "../api/analytics-client.js";
import { showToast } from "./toast.js";
import { isPathPanelOpen, openPathPanel, closePathPanel } from "./modals.js";
import { attachNodeAutocomplete } from "./autocomplete.js";
import { runServerPath } from "./path-result.js";
import { onSurfaceChange, getCurrentSurface, SURFACE_GAME } from "./router.js";

export function setupPathPanel() {
  els.btnFindPath?.addEventListener("click", () => {
    isPathPanelOpen() ? closePathPanel() : openPathPanel();
  });

  els.pathPanelClose?.addEventListener("click", closePathPanel);

  let _pathFromId = null;
  let _pathToId = null;

  const pathFromAc = $("path-from-ac");
  const pathToAc = $("path-to-ac");

  if (pathFromAc) {
    attachNodeAutocomplete(els.pathFromInput, pathFromAc, (name) => {
      const n = State.graphNodes.find((x) => x.name === name);
      _pathFromId = n ? n.id : null;
    });
  }

  if (pathToAc) {
    attachNodeAutocomplete(els.pathToInput, pathToAc, (name) => {
      const n = State.graphNodes.find((x) => x.name === name);
      _pathToId = n ? n.id : null;
    });
  }

  els.pathFromInput?.addEventListener("input", () => {
    _pathFromId = null;
  });
  els.pathToInput?.addEventListener("input", () => {
    _pathToId = null;
  });

  els.btnSwapPath?.addEventListener("click", () => {
    const fromVal = els.pathFromInput.value;
    const toVal = els.pathToInput.value;
    els.pathFromInput.value = toVal;
    els.pathToInput.value = fromVal;
    [_pathFromId, _pathToId] = [_pathToId, _pathFromId];
  });

  els.btnRunPath?.addEventListener("click", async () => {
    const fromRaw = (els.pathFromInput.value || "").trim();
    const toRaw = (els.pathToInput.value || "").trim();
    if (!fromRaw || !toRaw) {
      showToast("Enter both artist names.");
      return;
    }

    const fromParam = _pathFromId != null ? String(_pathFromId) : fromRaw;
    const toParam = _pathToId != null ? String(_pathToId) : toRaw;
    await runServerPath(fromParam, toParam, {
      loadingMessage: `Tracing a path from ${fromRaw} to ${toRaw}…`,
    });
  });

  els.btnClearPath?.addEventListener("click", () => {
    clearPathHighlight();
    if (els.hopChain) els.hopChain.innerHTML = "";
  });
}

export function setupHeroModeSwitch() {
  const switchEl = els.heroModeSwitch;
  const tabExplore = els.heroModeTabExplore;
  const tabConnect = els.heroModeTabConnect;
  const tabGame = els.heroModeTabGame;
  const panelExplore = els.heroModePanelExplore;
  const panelConnect = els.heroModePanelConnect;
  const panelGame = els.heroModePanelGame;
  if (!switchEl || !tabExplore || !tabConnect || !panelExplore || !panelConnect) return;

  const tabs = [tabExplore, tabConnect, tabGame].filter(Boolean);
  const modeForTab = (tab) =>
    tab === tabConnect ? "connect" : tab === tabGame ? "game" : "explore";

  function activate(mode) {
    State.heroMode = mode;
    switchEl.dataset.mode = mode;

    tabExplore.setAttribute("aria-selected", String(mode === "explore"));
    tabExplore.tabIndex = mode === "explore" ? 0 : -1;
    tabConnect.setAttribute("aria-selected", String(mode === "connect"));
    tabConnect.tabIndex = mode === "connect" ? 0 : -1;
    if (tabGame) {
      tabGame.setAttribute("aria-selected", String(mode === "game"));
      tabGame.tabIndex = mode === "game" ? 0 : -1;
    }

    panelExplore.classList.toggle("is-active", mode === "explore");
    panelConnect.classList.toggle("is-active", mode === "connect");
    panelGame?.classList.toggle("is-active", mode === "game");

    if (mode === "connect") els.heroPathFromInput?.focus();
    else if (mode === "explore") els.heroInput?.focus();
  }

  tabExplore.addEventListener("click", () => {
    if (State.heroMode !== "explore") activate("explore");
  });
  tabConnect.addEventListener("click", () => {
    if (State.heroMode !== "connect") activate("connect");
  });
  tabGame?.addEventListener("click", () => {
    if (State.heroMode !== "game") activate("game");
  });

  onSurfaceChange((surface) => {
    const onGame = surface === SURFACE_GAME;
    switchEl.dataset.mode = onGame ? "game" : State.heroMode;
    tabGame?.setAttribute("aria-selected", String(onGame));
    tabExplore.setAttribute("aria-selected", String(!onGame && State.heroMode === "explore"));
    tabConnect.setAttribute("aria-selected", String(!onGame && State.heroMode === "connect"));
  });
  if (getCurrentSurface() === SURFACE_GAME) {
    switchEl.dataset.mode = "game";
    tabGame?.setAttribute("aria-selected", "true");
    tabExplore.setAttribute("aria-selected", "false");
  }

  switchEl.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = tabs.indexOf(document.activeElement);
    let next;
    if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else next = tabs[(i + 1) % tabs.length];
    next.focus();
    activate(modeForTab(next));
  });
}

export function setupHeroPathFinder() {
  if (!els.btnHeroRunPath) return;

  let _fromId = null;
  let _toId = null;

  const fromAc = $("hero-path-from-ac");
  const toAc = $("hero-path-to-ac");

  if (fromAc) {
    attachNodeAutocomplete(els.heroPathFromInput, fromAc, (name) => {
      const n = State.graphNodes.find((x) => x.name === name);
      _fromId = n ? n.id : null;
    });
  }
  if (toAc) {
    attachNodeAutocomplete(els.heroPathToInput, toAc, (name) => {
      const n = State.graphNodes.find((x) => x.name === name);
      _toId = n ? n.id : null;
    });
  }

  els.heroPathFromInput?.addEventListener("input", () => {
    _fromId = null;
  });
  els.heroPathToInput?.addEventListener("input", () => {
    _toId = null;
  });

  els.btnHeroRunPath.addEventListener("click", async () => {
    const fromRaw = (els.heroPathFromInput.value || "").trim();
    const toRaw = (els.heroPathToInput.value || "").trim();
    if (!fromRaw || !toRaw) {
      showToast("Enter both artist names.");
      return;
    }

    const fromParam = _fromId != null ? String(_fromId) : fromRaw;
    const toParam = _toId != null ? String(_toId) : toRaw;
    await runServerPath(fromParam, toParam, {
      chainEl: els.heroHopChain,
      loadingMessage: `Tracing a path from ${fromRaw} to ${toRaw}…`,
    });
  });

  els.btnHeroSwapPath?.addEventListener("click", () => {
    const fromVal = els.heroPathFromInput.value;
    const toVal = els.heroPathToInput.value;
    els.heroPathFromInput.value = toVal;
    els.heroPathToInput.value = fromVal;
    [_fromId, _toId] = [_toId, _fromId];
  });

  els.btnHeroClearPath?.addEventListener("click", () => {
    els.heroPathFromInput.value = "";
    els.heroPathToInput.value = "";
    _fromId = null;
    _toId = null;
    if (els.heroHopChain) els.heroHopChain.innerHTML = "";
    els.heroPathFromInput?.focus();
  });
}
