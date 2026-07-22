// ════════════════════════════════════════════════════════════════════════════
// ui/path-panel.js — TASK 4: path-panel + hero-path-finder DOM wiring
//                    (setupPathPanel, setupHeroModeSwitch, setupHeroPathFinder).
//
// The server call / graph merge / hop-chain render (runServerPath,
// mergePathData, renderHopChain) live in path-result.js — this file only
// wires up the panel's inputs/buttons and calls runServerPath.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { els, $ } from "../dom/dom.js";
import { clearPathHighlight } from "../api/analytics-client.js";
import { showToast } from "./toast.js";
import { isPathPanelOpen, openPathPanel, closePathPanel } from "./modals.js";
import { attachNodeAutocomplete } from "./autocomplete.js";
import { runServerPath } from "./path-result.js";
import { onSurfaceChange, getCurrentSurface, SURFACE_GAME } from "./router.js";

// ════════════════════════════════════════════════════════════════════════════
// TASK 4: PATH PANEL
// ════════════════════════════════════════════════════════════════════════════

export function setupPathPanel() {
  // Toggle path panel — same open/close pair as the rest of the app instead
  // of a bare classList.toggle().
  els.btnFindPath?.addEventListener("click", () => {
    isPathPanelOpen() ? closePathPanel() : openPathPanel();
  });

  // Task 4: close button
  els.pathPanelClose?.addEventListener("click", closePathPanel);

  // [SF-WEB-24] Click-outside-to-close (same pattern as node-search-overlay
  // and docked search-modal) and click-inside-doesn't-bubble-and-self-close
  // both now come from the shared registration in
  // ui/modals.js::setupDockedPanels() — this used to be its own document
  // click listener.

  // [ТЗ-5 step 1-2] Genius AC for path fields — same factory as hero/dock.
  // Each field tracks its selected artist id so we can pass ?from=<id> to
  // the backend, bypassing fuzzy-resolve and the ambiguous-name error path.
  let _pathFromId = null;
  let _pathToId   = null;

  const pathFromAc = $("path-from-ac");
  const pathToAc   = $("path-to-ac");

  if (pathFromAc) {
    // Node AC (graph artists) with Genius fallback — kept for in-graph names.
    attachNodeAutocomplete(els.pathFromInput, pathFromAc, name => {
      // Name chosen from graph nodes — find the numeric id if available.
      const n = State.graphNodes.find(x => x.name === name);
      _pathFromId = n ? n.id : null;
    });
  }

  if (pathToAc) {
    attachNodeAutocomplete(els.pathToInput, pathToAc, name => {
      const n = State.graphNodes.find(x => x.name === name);
      _pathToId = n ? n.id : null;
    });
  }

  // Reset stored id when user edits field manually (no longer "selected").
  els.pathFromInput?.addEventListener("input", () => { _pathFromId = null; });
  els.pathToInput  ?.addEventListener("input", () => { _pathToId   = null; });

  // [fix] Variant B (of 5 mockups) swaps the decorative route-rail for a
  // functional swap button sitting between the two fields — same swap
  // logic setupHeroPathFinder's own #btn-hero-swap-path already uses.
  els.btnSwapPath?.addEventListener("click", () => {
    const fromVal = els.pathFromInput.value;
    const toVal   = els.pathToInput.value;
    els.pathFromInput.value = toVal;
    els.pathToInput.value   = fromVal;
    [_pathFromId, _pathToId] = [_pathToId, _pathFromId];
  });

  els.btnRunPath?.addEventListener("click", async () => {
    const fromRaw = (els.pathFromInput.value || "").trim();
    const toRaw   = (els.pathToInput.value   || "").trim();
    if (!fromRaw || !toRaw) { showToast("Enter both artist names."); return; }

    // [ТЗ-5 step 2] Prefer numeric id if the user selected from AC so the
    // backend skips fuzzy-resolve entirely (no ambiguous error possible).
    const fromParam = (_pathFromId != null) ? String(_pathFromId) : fromRaw;
    const toParam   = (_pathToId   != null) ? String(_pathToId)   : toRaw;
    await runServerPath(fromParam, toParam, { loadingMessage: `Tracing a path from ${fromRaw} to ${toRaw}…` });
  });

  // Task 4: clear path button
  els.btnClearPath?.addEventListener("click", () => {
    clearPathHighlight();
    if (els.hopChain) els.hopChain.innerHTML = "";
  });
}

// ────────────────────────────────────────────────────────────────────────────
// IDEA-41: hero mode switch — a segmented Explore/Connect tablist that sits
// above the hero search, replacing the old hidden find-path-toggle button
// + dual-input panel. "Explore" is the existing single-artist hero search
// (untouched); "Connect" swaps in the from/to path finder below (see
// setupHeroPathFinder). Both panels live in the same grid cell in the DOM
// (see .hero-mode-stage in index.html) so switching between them is a
// plain class toggle that CSS crossfades — no layout jump, no JS animation.
// ────────────────────────────────────────────────────────────────────────────
export function setupHeroModeSwitch() {
  const switchEl     = els.heroModeSwitch;
  const tabExplore   = els.heroModeTabExplore;
  const tabConnect   = els.heroModeTabConnect;
  const tabGame      = els.heroModeTabGame;
  const panelExplore = els.heroModePanelExplore;
  const panelConnect = els.heroModePanelConnect;
  const panelGame    = els.heroModePanelGame;
  if (!switchEl || !tabExplore || !tabConnect || !panelExplore || !panelConnect) return;

  const tabs = [tabExplore, tabConnect, tabGame].filter(Boolean);

  // [design: challenge setup on the landing page] All three panels now
  // crossfade the same shared grid cell (IDEA-41's original two-panel
  // convention, extended) — Game stopped being a "navigates away
  // immediately" special case; setting up a challenge is landing-native,
  // same as picking a search term or a path pair. Only the Game panel's
  // OWN "Start challenge" button (game/connect.js) actually leaves for
  // #/game, once both sides are already filled in.
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

    // ТЗ: переход в Connect всегда переводит фокус на первое поле; при
    // возврате в Explore фокус закономерно возвращается на hero-инпут.
    // [fix] Game's duel fields deliberately DON'T get this same auto-focus:
    // unlike hero-path-from-input (attachNodeAutocomplete, no focus
    // behavior of its own), the duel fields use attachGeniusAutocomplete,
    // whose focus handler opens a "recent searches" dropdown on an empty
    // field — auto-focusing here popped that dropdown open immediately on
    // every switch to the Game tab, overlapping "Start challenge" right
    // below it before the player had done anything.
    if (mode === "connect") els.heroPathFromInput?.focus();
    else if (mode === "explore") els.heroInput?.focus();
  }

  tabExplore.addEventListener("click", () => { if (State.heroMode !== "explore") activate("explore"); });
  tabConnect.addEventListener("click", () => { if (State.heroMode !== "connect") activate("connect"); });
  tabGame?.addEventListener("click", () => { if (State.heroMode !== "game") activate("game"); });

  // While actually ON #/game (past the landing setup step), the switch
  // still shows Game selected without touching State.heroMode — leaving
  // #/game (browser back, "← Back to graph") snaps the switch back to
  // whichever of explore/connect was last active, same restore behavior
  // this already had pre-redesign.
  onSurfaceChange(surface => {
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

  // Roving tabindex + arrow-key activation — standard WAI-ARIA tablist
  // keyboard pattern, over three equal tabs.
  switchEl.addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = tabs.indexOf(document.activeElement);
    let next;
    if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else next = tabs[(i + 1) % tabs.length];
    next.focus();
    activate(next === tabConnect ? "connect" : next === tabGame ? "game" : "explore");
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Find path — landing hero variant. Same server call (runServerPath) and
// same AC factory (attachNodeAutocomplete) as .path-panel above, just wired
// to the hero's own inputs/button so it works before a graph even exists
// (attachNodeAutocomplete already falls back to the Genius AC whenever
// State.graphNodes has no match, which is always true pre-search).
// ────────────────────────────────────────────────────────────────────────────
export function setupHeroPathFinder() {
  if (!els.btnHeroRunPath) return;

  let _fromId = null;
  let _toId   = null;

  const fromAc = $("hero-path-from-ac");
  const toAc   = $("hero-path-to-ac");

  if (fromAc) {
    attachNodeAutocomplete(els.heroPathFromInput, fromAc, name => {
      const n = State.graphNodes.find(x => x.name === name);
      _fromId = n ? n.id : null;
    });
  }
  if (toAc) {
    attachNodeAutocomplete(els.heroPathToInput, toAc, name => {
      const n = State.graphNodes.find(x => x.name === name);
      _toId = n ? n.id : null;
    });
  }

  els.heroPathFromInput?.addEventListener("input", () => { _fromId = null; });
  els.heroPathToInput  ?.addEventListener("input", () => { _toId   = null; });

  els.btnHeroRunPath.addEventListener("click", async () => {
    const fromRaw = (els.heroPathFromInput.value || "").trim();
    const toRaw   = (els.heroPathToInput.value   || "").trim();
    if (!fromRaw || !toRaw) { showToast("Enter both artist names."); return; }

    const fromParam = (_fromId != null) ? String(_fromId) : fromRaw;
    const toParam   = (_toId   != null) ? String(_toId)   : toRaw;
    // A successful path builds its own graph on canvas and closes the
    // landing modal (see mergePathData → initGraphOnCanvas), same as a
    // regular hero search. The hop chain itself renders inline into the
    // Connect panel (heroHopChain), reusing renderHopChain's own markup/CSS
    // — loading/errors go through the shared canvas overlay/toast instead
    // (see runServerPath's own comment).
    await runServerPath(fromParam, toParam, {
      chainEl: els.heroHopChain,
      loadingMessage: `Tracing a path from ${fromRaw} to ${toRaw}…`,
    });
  });

  // IDEA-41: compact Swap/Clear controls next to "Trace the path".
  els.btnHeroSwapPath?.addEventListener("click", () => {
    const fromVal = els.heroPathFromInput.value;
    const toVal   = els.heroPathToInput.value;
    els.heroPathFromInput.value = toVal;
    els.heroPathToInput.value   = fromVal;
    [_fromId, _toId] = [_toId, _fromId];
  });

  els.btnHeroClearPath?.addEventListener("click", () => {
    els.heroPathFromInput.value = "";
    els.heroPathToInput.value   = "";
    _fromId = null;
    _toId   = null;
    if (els.heroHopChain) els.heroHopChain.innerHTML = "";
    els.heroPathFromInput?.focus();
  });
}
