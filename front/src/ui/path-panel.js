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
import { isPathPanelOpen, closePathPanel } from "./modals.js";
import { attachNodeAutocomplete } from "./autocomplete.js";
import { runServerPath } from "./path-result.js";

// ════════════════════════════════════════════════════════════════════════════
// TASK 4: PATH PANEL
// ════════════════════════════════════════════════════════════════════════════

export function setupPathPanel() {
  // Task 4: close button
  els.pathPanelClose?.addEventListener("click", closePathPanel);

  // Клик вне панели закрывает её — тот же паттерн, что у node-search-overlay
  // и search-modal (click on backdrop = close).
  // [SF-WEB-21] No more #btn-find-path rail button to open this — the
  // palette's "Find a path" command calls openPathPanel()/closePathPanel()
  // directly (see ui/modals.js::_commands), so there's no trigger element
  // to exempt from the click-outside check anymore.
  els.pathPanel?.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", e => {
    if (!isPathPanelOpen()) return;
    if (els.pathPanel.contains(e.target)) return;
    closePathPanel();
  });

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

  els.btnRunPath?.addEventListener("click", async () => {
    const fromRaw = (els.pathFromInput.value || "").trim();
    const toRaw   = (els.pathToInput.value   || "").trim();
    if (!fromRaw || !toRaw) { showToast("Enter both artist names."); return; }

    // [ТЗ-5 step 2] Prefer numeric id if the user selected from AC so the
    // backend skips fuzzy-resolve entirely (no ambiguous error possible).
    const fromParam = (_pathFromId != null) ? String(_pathFromId) : fromRaw;
    const toParam   = (_pathToId   != null) ? String(_pathToId)   : toRaw;
    await runServerPath(fromParam, toParam);
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
  const panelExplore = els.heroModePanelExplore;
  const panelConnect = els.heroModePanelConnect;
  if (!switchEl || !tabExplore || !tabConnect || !panelExplore || !panelConnect) return;

  function activate(mode) {
    const toConnect = mode === "connect";
    State.heroMode = mode;
    switchEl.dataset.mode = mode;

    tabExplore.setAttribute("aria-selected", String(!toConnect));
    tabExplore.tabIndex = toConnect ? -1 : 0;
    tabConnect.setAttribute("aria-selected", String(toConnect));
    tabConnect.tabIndex = toConnect ? 0 : -1;

    panelExplore.classList.toggle("is-active", !toConnect);
    panelConnect.classList.toggle("is-active", toConnect);

    // ТЗ: переход в Connect всегда переводит фокус на первое поле; при
    // возврате в Explore фокус закономерно возвращается на hero-инпут.
    if (toConnect) els.heroPathFromInput?.focus();
    else els.heroInput?.focus();
  }

  tabExplore.addEventListener("click", () => { if (State.heroMode !== "explore") activate("explore"); });
  tabConnect.addEventListener("click", () => { if (State.heroMode !== "connect") activate("connect"); });

  // Roving tabindex + arrow-key activation — standard WAI-ARIA tablist
  // keyboard pattern (only two tabs, so Left/Right/Home/End all just swap).
  switchEl.addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = document.activeElement === tabConnect ? tabExplore : tabConnect;
    next.focus();
    activate(next === tabConnect ? "connect" : "explore");
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
    // Connect panel (heroHopChain), reusing renderHopChain's own markup/CSS.
    await runServerPath(fromParam, toParam, { resultEl: els.heroPathResult, chainEl: els.heroHopChain });
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
    if (els.heroPathResult) { els.heroPathResult.className = "path-result"; els.heroPathResult.textContent = ""; }
    if (els.heroHopChain)   els.heroHopChain.innerHTML = "";
    els.heroPathFromInput?.focus();
  });
}
