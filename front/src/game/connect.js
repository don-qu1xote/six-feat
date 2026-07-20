// ════════════════════════════════════════════════════════════════════════════
// game/connect.js — [SF-GAME-01] "Connect" game surface controller (split
// layout: live chain-graph on the left, docked track panel on the right).
//
// Pick a start + goal artist, then build the collaboration chain between them
// one intermediate at a time. The left pane renders the current chain as an
// Observatory-styled graph (chain-graph.js) — same visual world as the
// explorer; the right dock is the structured track panel (endpoints, the chain
// as a list, the add-artist field, undo/reset, status). Both drive the same
// pure, unit-tested model (connect-model.js).
//
// [SF-GAME-14/02] Per-hop valid/invalid highlighting renders off
// State.connect.game.validation (see connect-model.js's applyValidation/
// hopStatuses) whenever it's set. [SF-GAME-15/03] The result screen
// (renderResult below) renders off State.connect.game.result (applyResult/
// resultView) the same way — but nothing here actually calls the server
// yet: both wire contracts (POST /api/v1/game/validate, POST
// /api/v1/game/submit) need numeric Genius artist ids, and this model
// still only carries names (see connect-model.js's own header comment).
// Once a later ticket adds id-aware endpoints, wiring the real calls is
// just applyValidation()/applyResult() plus a render() — the rendering
// side for both is already complete and tested.
//
// This is purely the input mechanic on the existing design kit, on the
// #/game surface the router (ui/router.js, SF-WEB-25) already knows about.
// Every field also accepts a plain typed name on Enter, so it works even
// with no backend reachable (the Genius autocomplete needs one; the
// mechanic doesn't). The whole game lives in State.connect (per the
// ticket) — no module-local game state.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { escapeHtml } from "../state/helpers.js";
import { onSurfaceChange, getCurrentSurface, navigateToSurface, SURFACE_GAME, SURFACE_GRAPH } from "../ui/router.js";
import { attachGeniusAutocomplete } from "../ui/autocomplete.js";
import {
  createConnectChain, chainNodes, hopCount, isComplete,
  addHop, undoHop, resetChain, hopStatuses, resultView, leaderboardView,
} from "./connect-model.js";
import { drawChain } from "./chain-graph.js";

function slice() {
  if (!State.connect) State.connect = { startName: "", goalName: "", game: null };
  return State.connect;
}

function endpointsReady() {
  const s = slice();
  return s.startName.trim().length > 0 && s.goalName.trim().length > 0;
}

// (Re)build the chain model whenever both endpoints are set — a changed
// endpoint invalidates any half-built chain against the old pair, so this
// starts fresh.
function syncGame() {
  const s = slice();
  s.game = endpointsReady() ? createConnectChain(s.startName, s.goalName) : null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderChainList() {
  const s = slice();
  if (!els.connectChain) return;
  if (!s.game) {
    els.connectChain.innerHTML = `<p class="connect-empty">Choose a start and a goal to begin.</p>`;
    return;
  }
  const nodes = chainNodes(s.game);
  const last = nodes.length - 1;
  // [SF-GAME-14/02] statuses[i-1] is the server's verdict on the transition
  // INTO row i (nodes[i-1] -> nodes[i]) — rendered on the connecting line
  // (ct-link), since it's the HOP that was checked, not the arriving artist.
  const statuses = hopStatuses(s.game);
  els.connectChain.innerHTML = nodes.map((name, i) => {
    const role = i === 0 ? "start" : i === last ? "goal" : "hop";
    const ini = name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const tag = role === "start" ? '<span class="ct-tag ct-start">Start</span>'
      : role === "goal" ? '<span class="ct-tag ct-goal">Goal</span>' : "";
    const st = i > 0 ? statuses[i - 1] : null;
    const stClass = st && st !== "unknown" ? ` ct-hop-${st}` : "";
    return `<div class="ct-row ct-${role}${i > 0 ? " ct-link" : ""}${stClass}">` +
      `<span class="ct-node">${escapeHtml(ini)}</span>` +
      `<span class="ct-name">${escapeHtml(name)}${tag}</span></div>`;
  }).join("");
}

function renderStatus() {
  const s = slice();
  if (!els.connectStatus) return;
  if (!s.game) { els.connectStatus.textContent = ""; return; }
  els.connectStatus.textContent = isComplete(s.game)
    ? `Connected in ${hopCount(s.game)} hop${hopCount(s.game) === 1 ? "" : "s"}.`
    : `${hopCount(s.game)} hop${hopCount(s.game) === 1 ? "" : "s"} — reach ${s.goalName}.`;
}

function renderControls() {
  const s = slice();
  const active = !!s.game;
  const completed = active && isComplete(s.game);
  if (els.connectAddInput) els.connectAddInput.disabled = !active || completed;
  if (els.connectUndo) els.connectUndo.disabled = !active || (hopCount(s.game) === 0 && !completed);
  if (els.connectReset) els.connectReset.disabled = !active || (hopCount(s.game) === 0 && !completed);
}

// [SF-GAME-15/03] Renders State.connect.game.result — see resultView's own
// doc-comment for why the ideal (optimalPath/optimalLen) can only ever show
// up here, never earlier. Hidden whenever there's nothing to show yet.
function renderResult() {
  const s = slice();
  if (!els.connectResult) return;
  const view = s.game ? resultView(s.game) : null;
  if (!view) {
    els.connectResult.hidden = true;
    els.connectResult.innerHTML = "";
    return;
  }
  els.connectResult.hidden = false;

  if (!view.revealed) {
    const at = view.invalidHopIndex != null ? `hop ${view.invalidHopIndex + 1}` : "a hop";
    els.connectResult.innerHTML =
      `<p class="connect-result-status connect-result-status--rejected">` +
      `Not a real chain — the check failed at ${escapeHtml(at)}.</p>`;
    return;
  }

  const sign = view.eloDelta > 0 ? "+" : "";
  els.connectResult.innerHTML =
    `<p class="connect-result-score">${view.score} <span class="cr-of">/ ${view.maxScore}</span></p>` +
    `<p class="connect-result-elo">Elo ${view.eloBefore} → ${view.eloAfter} ` +
    `<span class="cr-delta ${view.eloDelta >= 0 ? "cr-delta--up" : "cr-delta--down"}">(${sign}${view.eloDelta})</span></p>` +
    `<div class="connect-result-compare">` +
    `<div class="cr-row"><span class="cr-label">You</span>` +
    `<span class="cr-val">${view.playerLen} hop${view.playerLen === 1 ? "" : "s"}</span></div>` +
    `<div class="cr-row cr-row--ideal"><span class="cr-label">Ideal</span>` +
    `<span class="cr-val">${view.optimalLen} hop${view.optimalLen === 1 ? "" : "s"}</span></div>` +
    `</div>`;
}

// [SF-GAME-17/04] Renders State.connect.game.leaderboard — see
// leaderboardView's own doc-comment. Only ever has something to show once a
// result has been revealed (applyLeaderboard is only ever called after
// applyResult in practice), and is hidden otherwise.
function renderLeaderboard() {
  const s = slice();
  if (!els.connectLeaderboard) return;
  const view = s.game ? leaderboardView(s.game) : null;
  if (!view || !view.entries.length) {
    els.connectLeaderboard.hidden = true;
    els.connectLeaderboard.innerHTML = "";
    return;
  }
  els.connectLeaderboard.hidden = false;
  const rows = view.entries.map((e, i) =>
    `<div class="cl-row"><span class="cl-rank">${i + 1}</span>` +
    `<span class="cl-name">${escapeHtml(e.displayName)}</span>` +
    `<span class="cl-score">${e.score}</span></div>`).join("");
  els.connectLeaderboard.innerHTML =
    `<h4 class="connect-leaderboard-title">Leaderboard</h4>${rows}`;
}

function draw() {
  if (els.connectCanvas) drawChain(els.connectCanvas, slice().game);
}

function render() {
  renderChainList();
  renderStatus();
  renderResult();
  renderLeaderboard();
  renderControls();
  draw();
}

// ── Interactions (exported for direct driving in tests/harnesses) ────────────

export function setStartArtist(name) { slice().startName = String(name || ""); syncGame(); render(); }
export function setGoalArtist(name) { slice().goalName = String(name || ""); syncGame(); render(); }

export function commitHop(name) {
  const s = slice();
  if (!s.game) return null;
  const res = addHop(s.game, name);
  if (res.ok && els.connectAddInput) els.connectAddInput.value = "";
  render();
  return res;
}

export function undoLast() { const s = slice(); if (s.game) { undoHop(s.game); render(); } }
export function resetGame() { const s = slice(); if (s.game) { resetChain(s.game); render(); } }

// Test/introspection hook — the current chain snapshot (never mutate).
export function _currentChain() { return slice().game; }

// ── Wiring ───────────────────────────────────────────────────────────────

let _wired = false;

function commitField(inputEl, apply) {
  const v = (inputEl?.value || "").trim();
  if (v) apply(v);
}

export function setupConnectMode() {
  if (!els.connectSurface) return;   // no surface markup (e.g. jsdom unit context)

  if (els.connectStartInput) {
    attachGeniusAutocomplete(els.connectStartInput, els.connectStartAc,
      name => { els.connectStartInput.value = name; setStartArtist(name); });
    els.connectStartInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitField(els.connectStartInput, setStartArtist); }
    });
  }
  if (els.connectGoalInput) {
    attachGeniusAutocomplete(els.connectGoalInput, els.connectGoalAc,
      name => { els.connectGoalInput.value = name; setGoalArtist(name); });
    els.connectGoalInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitField(els.connectGoalInput, setGoalArtist); }
    });
  }
  if (els.connectAddInput) {
    attachGeniusAutocomplete(els.connectAddInput, els.connectAddAc, name => { commitHop(name); });
    els.connectAddInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitHop(els.connectAddInput.value); }
    });
  }

  els.connectUndo?.addEventListener("click", undoLast);
  els.connectReset?.addEventListener("click", resetGame);
  els.btnGameMode?.addEventListener("click", () => navigateToSurface(SURFACE_GAME));
  els.connectBack?.addEventListener("click", () => navigateToSurface(SURFACE_GRAPH));

  // The chain-graph canvas is sized to its (flex) stage, so it must be
  // redrawn once the surface is visible and laid out, and on window resize.
  if (!_wired) {
    _wired = true;
    window.addEventListener("resize", () => { if (getCurrentSurface() === SURFACE_GAME) draw(); });
  }

  const applySurface = surface => {
    const on = surface === SURFACE_GAME;
    els.connectSurface.classList.toggle("show", on);
    els.connectSurface.hidden = !on;
    document.body.classList.toggle("surface-game", on);
    if (on) requestAnimationFrame(draw);   // stage now has a real size
  };
  onSurfaceChange(applySurface);
  applySurface(getCurrentSurface());

  render();
}
