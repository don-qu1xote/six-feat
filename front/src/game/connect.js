// ════════════════════════════════════════════════════════════════════════════
// game/connect.js — [SF-GAME-01] "Connect" game surface controller.
//
// [design: reuse the graph mockup] Single-column "quest" layout: a real
// chain-graph canvas stage at the top (chain-graph.js), the typed composer
// docked right under it as the PRIMARY way to build the chain, and a
// collapsed "browse real collaborators" disclosure (game-graph.js's
// fetchNeighbours, same /api/v1/graph the explorer uses) as a SECONDARY,
// lower-priority shortcut. Both drive the same commitHop() pipeline.
//
// [design: real backend] Wires the actual game service now that it's
// restored (services/game/*): POST /api/v1/game/challenge once both
// endpoints are set (needs numeric ids — see resolveId below), POST
// /api/v1/game/submit once the chain reaches the goal, GET
// /api/v1/game/leaderboard right after a scored submit. Nothing here
// fakes a request or shows a "not wired yet" toast — every network call
// is real.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { escapeHtml, initialOf } from "../state/helpers.js";
import { navigateToSurface, onSurfaceChange, getCurrentSurface, SURFACE_GAME } from "../ui/router.js";
import { attachGeniusAutocomplete } from "../ui/autocomplete.js";
import { apiFetch } from "../api/net.js";
import { showToast } from "../ui/toast.js";
import {
  createConnectChain, chainNodes, hopCount, isComplete, webSize,
  addHop, undoHop, resetChain, giveUp as modelGiveUp, pathRevealed,
  elapsedMs, setChallengeId, applyResult, resultView,
  applyLeaderboard, leaderboardView,
  winningPath, focusName, setFocus,
} from "./connect-model.js";
import { renderBoard, zoomBoard, fitBoard, mountBoard, unmountBoard } from "./game-board.js";
import { fetchNeighbours } from "./game-graph.js";
import { createChallenge, submitChain, fetchLeaderboard, fetchDailyChallenge, checkLink } from "./game-api.js";

// ── [SF-GAME-05] Deep-link sharing ───────────────────────────────────────────
// Same URLSearchParams-on-.search convention as history.js's own
// serializeGraphState/parseGraphState (router.js only ever touches .hash, so
// the two compose for free — see router.js's own module comment). Only the
// two artist NAMES travel in the link, never a challenge id: loading a link
// just pre-fills the start/goal fields exactly as if the recipient had typed
// them themselves, which already drives the real POST /api/v1/game/challenge
// (create-or-get, idempotent by pair — see challenge_handler.cpp) through
// syncGame()/ensureChallenge() below, unchanged. No new endpoint, no
// id-resolution the recipient's own session couldn't already do itself.
export function serializeGameShareState({ from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params;
}

export function parseGameShareState(search) {
  const params = new URLSearchParams(search || "");
  return { from: params.get("from") || null, to: params.get("to") || null };
}

// Copies a shareable link for the CURRENT challenge (both endpoints already
// set) — same clipboard-write-then-toast pattern as history.js's own
// copyShareableLink, scoped to the game surface's own state instead.
export function shareCurrentChallenge() {
  const s = slice();
  if (!s.game) return;
  const url = new URL(window.location.href);
  url.hash = "#/game";
  url.search = serializeGameShareState({ from: s.game.start, to: s.game.goal }).toString();
  navigator.clipboard.writeText(url.toString())
    .then(() => showToast("🔗 Link copied!", 2000, true))
    .catch(() => showToast(`Copy: ${url.toString()}`, 5000));
}

function slice() {
  if (!State.connect) State.connect = { startName: "", goalName: "", game: null, photos: {}, ids: {}, frontier: null, rivalBanner: null, par: null, seasonId: null, submitted: false };
  if (!State.connect.photos) State.connect.photos = {};
  if (!State.connect.ids) State.connect.ids = {};
  return State.connect;
}

function setPhoto(name, url) {
  if (!name || !url) return;
  slice().photos[name] = url;
}
function setId(name, id) {
  if (!name || id == null) return;
  slice().ids[name] = id;
}
function idFor(name) {
  return slice().ids[name] ?? null;
}
function eqName(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

// [design: manual entry is primary] A typed name has no id unless it came
// from an autocomplete pick — this resolves it via the same /api/v1/search
// the autocomplete itself uses, taking the top candidate, so a hop typed
// and confirmed with Enter (never touching the dropdown) still gets a
// real id by the time it matters (submit needs one for every node).
// Caches the result via setId either way, so this only ever does the
// lookup once per name.
async function resolveId(name) {
  const cached = idFor(name);
  if (cached != null) return cached;
  try {
    const res = await apiFetch(`/api/v1/search?q=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const top = data?.candidates?.[0];
    if (!top || top.id == null) return null;
    setId(name, top.id);
    if (top.image) setPhoto(name, top.image);
    return top.id;
  } catch {
    return null;
  }
}

function endpointsReady() {
  const s = slice();
  return s.startName.trim().length > 0 && s.goalName.trim().length > 0;
}

let _endpointsExpanded = false;

function syncGame() {
  const s = slice();
  s.game = endpointsReady() ? createConnectChain(s.startName, s.goalName) : null;
  // Collapse the endpoint editor once both endpoints are known (a fresh
  // pick is done); leave it open while still incomplete.
  _endpointsExpanded = false;
  s.frontier = null;
  s.par = null;         // PAR (challenge optimal_len) is (re)filled by ensureChallenge
  s.submitted = false;  // a fresh line has never been locked in
  // A fresh chain always starts with no rival banner — pickRival (landing
  // panel) sets it back AFTER both setStartArtist/setGoalArtist calls
  // that trigger this same syncGame, so it survives the reset.
  s.rivalBanner = null;
  if (s.game) ensureChallenge();
}

// [design: real backend] Creates (or fetches) the challenge for this
// (start, goal) pair as soon as both are known — needs numeric ids for
// both, resolving them the same way commitHop does for typed hops.
// Silently gives up (challengeId stays null) on any failure; submitRound
// checks for that and tells the player honestly rather than pretending
// to score an unscoreable attempt.
async function ensureChallenge() {
  const s = slice();
  const game = s.game;
  if (!game) return;
  const [fromId, toId] = await Promise.all([resolveId(game.start), resolveId(game.goal)]);
  if (s.game !== game) return; // superseded by a newer chain/reset
  if (fromId == null || toId == null) { render(); return; }
  const challenge = await createChallenge(fromId, toId, 0);
  if (s.game !== game) return;
  if (challenge && challenge.id) setChallengeId(game, challenge.id);
  // [design: PAR pill] The challenge's own ideal length (optimal_len) — the
  // "par" for this quest. Shown in the graph overlay; never reveals the
  // ideal PATH, only its length (same info the finish card already shows).
  if (challenge && challenge.optimal_len != null) s.par = challenge.optimal_len;
  // [design: routed game windows] Remember this challenge's season so the
  // Leaderboard screen's "Season" tab has a season_id to query even when the
  // player opens it straight from a game.
  if (challenge && challenge.season_id != null) s.seasonId = challenge.season_id;
  render();
}

// [design: ветвящийся веб] The frontier (dandelion of real collaborators)
// blooms around the FOCUSED node — the branch point the player is extending,
// which moves as they type or click a node to branch — not a linear tail.
function currentTailName(game) {
  return focusName(game);
}

let _frontierToken = 0;

async function refreshFrontier() {
  const s = slice();
  if (!s.game || pathRevealed(s.game)) { s.frontier = null; render(); return; }
  const tail = currentTailName(s.game);
  const token = ++_frontierToken;
  let id = idFor(tail);
  if (id == null) id = await resolveId(tail);
  if (token !== _frontierToken) return;
  if (id == null) {
    s.frontier = { centerName: tail, loading: false, neighbours: [], unavailable: true };
    render();
    return;
  }
  s.frontier = { centerName: tail, loading: true, neighbours: [] };
  render();
  const result = await fetchNeighbours(id);
  if (token !== _frontierToken) return;
  const s2 = slice();
  if (!s2.game) return;
  s2.frontier = result
    ? { centerName: tail, loading: false, neighbours: result.neighbours }
    : { centerName: tail, loading: false, neighbours: [], failed: true };
  render();
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderHead() {
  const s = slice();
  if (els.connectTitleStart) els.connectTitleStart.textContent = s.game ? s.game.start : (s.startName || "Start");
  if (els.connectTitleGoal)  els.connectTitleGoal.textContent  = s.game ? s.game.goal  : (s.goalName || "Goal");
  if (els.connectHopsValue)  els.connectHopsValue.textContent  = s.game ? String(hopCount(s.game)) : "0";

  // PAR pill — the challenge's ideal length, once known.
  if (els.connectParPill) {
    const showPar = s.game && s.par != null;
    els.connectParPill.hidden = !showPar;
    if (showPar && els.connectParValue) els.connectParValue.textContent = String(s.par);
  }

  if (els.connectRivalPill) {
    const rival = s.game ? s.rivalBanner : null;
    els.connectRivalPill.hidden = !rival;
    if (rival && els.connectRivalText) {
      els.connectRivalText.textContent = `Chasing ${rival.name} · ${rival.score}`;
    }
  }
}

// [design: ветвящийся веб] The player's current LINE — the branch from the
// start to the focused node (chainNodes now returns start→focus). Rows are
// clickable to re-focus that node, and the focused node is marked; a footer
// note counts artists sitting on other branches so the web off-screen is
// never invisible. Roles are by identity (start/goal), not position, since
// the branch's last node is the focus and only equals the goal once won.
function renderLine() {
  const s = slice();
  if (!els.connectLineList) return;
  if (!s.game) { els.connectLineList.innerHTML = ""; return; }
  const game = s.game;
  const names = chainNodes(game);
  const focus = focusName(game);
  const rows = names.map(name => {
    const isStart = name === game.start, isGoal = name === game.goal;
    const role = isStart ? "start" : isGoal ? "goal" : "hop";
    const isFocus = name === focus;
    const photo = s.photos[name];
    const avatar = photo
      ? `<img class="clp-av" src="${escapeHtml(photo)}" alt="" />`
      : `<span class="clp-av clp-av--${role}">${escapeHtml(initialOf(name))}</span>`;
    const sub = isStart ? "the origin"
      : isGoal ? (game.completed ? "reached" : "the target")
      : isFocus ? "branching from here" : "collaborator";
    return `<li class="clp-row clp-row--${role}${isFocus ? " is-focus" : ""}" data-name="${escapeHtml(name)}">${avatar}` +
      `<span class="clp-row-main"><span class="clp-row-name">${escapeHtml(name)}</span>` +
      `<span class="clp-row-sub">${sub}</span></span></li>`;
  }).join("");
  const offBranch = webSize(game) - Math.max(0, names.length - 1);
  const note = offBranch > 0
    ? `<li class="clp-web-note">+${offBranch} on other branch${offBranch === 1 ? "" : "es"} — click any node to jump there</li>`
    : "";
  els.connectLineList.innerHTML = rows + note;
}

function renderEndpoints() {
  // The quest pill (#connect-endpoints-summary) is always visible — renderHead
  // keeps its start/goal spans current. This only toggles the editor popover.
  const editing = _endpointsExpanded || !endpointsReady();
  if (els.connectEndpoints) els.connectEndpoints.hidden = !editing;
}

function draw() {
  const s = slice();
  // [design: настоящий граф эксплорера] Renders the game state onto the REAL
  // #network engine (game-board.js), restricted to the line + focus dandelion.
  renderBoard(s.game, s.photos, s.frontier, s.ids, {
    onPick: selectBrowseNode,             // click a frontier collaborator → add under focus (known-linked)
    onFocus: focusNodeByName,             // click a web node → branch from it
    onReachGoal: () => commitTypedHop(s.game ? s.game.goal : ""), // click the goal target → verify focus connects, then reach
  });
}

// [design: ветвящийся веб] Move the focus to an already-built node so the
// next add branches off it. Re-fetches that node's collaborators (the
// dandelion follows the focus). No-op if the round is over or the name isn't
// in the web.
function focusNodeByName(name) {
  const s = slice();
  if (!s.game) return;
  if (setFocus(s.game, name).ok) { render(); refreshFrontier(); }
}

function renderStage() {
  const s = slice();
  if (els.connectStageEmpty) els.connectStageEmpty.hidden = !!s.game;
  draw();
}

function renderComposer() {
  const s = slice();
  const active = !!s.game;
  const completed = active && isComplete(s.game);
  const usable = active && !completed && !s.game.gaveUp;
  if (els.connectAddInput) els.connectAddInput.disabled = !usable;
  if (els.connectAddBtn) els.connectAddBtn.disabled = !usable;
}

// [design: reuse the graph mockup] The SECONDARY click-to-expand chip
// list — collapsed by default (see index.html's <details>), populated
// from the real /api/v1/graph fetch above.
function renderBrowse() {
  const s = slice();
  if (!els.connectBrowse) return;
  if (!s.game || pathRevealed(s.game) || !s.frontier) {
    els.connectBrowse.hidden = true;
    if (els.connectBrowseChips) els.connectBrowseChips.innerHTML = "";
    return;
  }
  els.connectBrowse.hidden = false;
  if (els.connectBrowseLabel) els.connectBrowseLabel.textContent = `Or browse ${s.frontier.centerName}'s real collaborators`;
  const f = s.frontier;
  if (!els.connectBrowseChips) return;
  if (f.unavailable) {
    els.connectBrowseChips.innerHTML = `<p class="connect-browse-empty">No graph data for ${escapeHtml(f.centerName)} yet — type a name above instead.</p>`;
    return;
  }
  if (f.loading) {
    els.connectBrowseChips.innerHTML = `<p class="connect-browse-loading">Loading ${escapeHtml(f.centerName)}'s collaborators…</p>`;
    return;
  }
  if (f.failed || !f.neighbours.length) {
    els.connectBrowseChips.innerHTML = `<p class="connect-browse-empty">No collaborators found for ${escapeHtml(f.centerName)}.</p>`;
    return;
  }
  const goalId = idFor(s.game.goal);
  els.connectBrowseChips.innerHTML = f.neighbours.map(n => {
    const isGoal = goalId != null && n.id === goalId;
    const ini = n.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const avatar = n.image
      ? `<img class="cb-avatar" src="${escapeHtml(n.image)}" alt="" />`
      : `<span class="cb-avatar cb-avatar--fallback">${escapeHtml(ini)}</span>`;
    return `<button type="button" class="cb-chip${isGoal ? " cb-chip--goal" : ""}" data-id="${n.id}">` +
      avatar + `<span class="cb-name">${escapeHtml(n.name)}</span></button>`;
  }).join("");
}

function renderMiniActions() {
  const s = slice();
  const active = !!s.game;
  const completed = active && isComplete(s.game);
  if (els.connectUndo) els.connectUndo.disabled = !active || (hopCount(s.game) === 0 && !completed);
  if (els.connectReset) els.connectReset.disabled = !active || (hopCount(s.game) === 0 && !completed);
  if (els.connectGiveUp) els.connectGiveUp.disabled = !active || completed || s.game.gaveUp || hopCount(s.game) === 0;
  // [SF-GAME-05] Share makes sense as soon as both endpoints are known —
  // it links to the (from, to) pair, not to any particular hop progress.
  if (els.connectShare) els.connectShare.disabled = !active;
}

// [design: Lock in] Explicit submit — the line reaching the goal no longer
// auto-scores (that was the old flow); the player assembles the whole line,
// INCLUDING the target, then clicks Lock in. Enabled only when the line is
// complete and hasn't been submitted / given up yet.
function renderLockin() {
  const s = slice();
  if (!els.connectLockin) return;
  const complete = s.game && isComplete(s.game) && !s.game.gaveUp;
  els.connectLockin.disabled = !complete || s.submitted;
  els.connectLockin.textContent = s.submitted ? "Locked in" : "Lock in";
}

// Footer score value + the status/detail lines. Nothing is shown until the
// player actually locks in (s.submitted) or gives up — no "Scoring…" the
// instant they merely reach the goal, since submitting is now a deliberate
// click.
function renderFinish() {
  const s = slice();
  const scoreEl = els.connectFinishScore, labelEl = els.connectFinishLabel, detailEl = els.connectFinishDetail;
  const setLabel = t => { if (labelEl) labelEl.textContent = t || ""; };
  const setScore = t => { if (scoreEl) scoreEl.textContent = t; };
  const hideDetail = () => { if (detailEl) detailEl.hidden = true; };

  if (!s.game) { setScore("—"); setLabel(""); hideDetail(); return; }

  const view = resultView(s.game);

  if (s.game.gaveUp && !view) { setScore("—"); setLabel("You gave up — no score for this attempt."); hideDetail(); return; }

  if (!s.submitted && !view) { setScore("—"); setLabel(""); hideDetail(); return; }

  if (!view) { setScore("…"); setLabel("Scoring…"); hideDetail(); return; }

  if (!view.revealed) {
    setScore("0");
    const at = view.invalidHopIndex != null ? `hop ${view.invalidHopIndex + 1}` : "a hop";
    setLabel(`Not a real chain — the check failed at ${at}.`);
    hideDetail();
    return;
  }

  setScore(`${view.score}`);
  setLabel("");
  if (detailEl) {
    detailEl.hidden = false;
    const sign = view.eloDelta > 0 ? "+" : "";
    detailEl.textContent =
      `${view.score} / ${view.maxScore} · You: ${view.playerLen} hop${view.playerLen === 1 ? "" : "s"} · ` +
      `Ideal: ${view.optimalLen} · Elo ${view.eloBefore} → ${view.eloAfter} (${sign}${view.eloDelta})`;
  }
}

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
  els.connectLeaderboard.innerHTML = `<h4 class="connect-leaderboard-title">Leaderboard</h4>${rows}`;
}

let _tickHandle = null;
function renderTimer() {
  const s = slice();
  if (!els.connectTimerValue) return;
  els.connectTimerValue.textContent = s.game ? formatElapsed(elapsedMs(s.game)) : "0:00";
}
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function ensureTicking() {
  const s = slice();
  const shouldTick = !!(s.game && !s.game.finishedAt);
  if (shouldTick && !_tickHandle) _tickHandle = setInterval(renderTimer, 500);
  else if (!shouldTick && _tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
}

function render() {
  renderHead();
  renderEndpoints();
  renderLine();
  renderStage();
  renderComposer();
  renderBrowse();
  renderMiniActions();
  renderLockin();
  renderFinish();
  renderLeaderboard();
  renderTimer();
  ensureTicking();
}

// ── Interactions ─────────────────────────────────────────────────────────────

export function setStartArtist(name) { slice().startName = String(name || ""); syncGame(); render(); refreshFrontier(); }
export function setGoalArtist(name)  { slice().goalName  = String(name || ""); syncGame(); render(); refreshFrontier(); }

export function commitHop(name) {
  const s = slice();
  if (!s.game) return null;
  const res = addHop(s.game, name);
  if (res.ok && els.connectAddInput) els.connectAddInput.value = "";
  // [design: Lock in] Reaching the goal no longer auto-submits — it just
  // completes the line and enables the Lock in button. A fresh completion
  // is never already-submitted.
  if (res.ok && res.completed) s.submitted = false;
  render();
  if (res.ok && !res.completed) { resolveId(name); refreshFrontier(); }
  return res;
}

// [design: живая проверка хода / game #2] Is `name` a real collaborator of
// the current focus? Fast-path: if it's one of the focus's already-fetched
// dandelion collaborators, it's connected by construction — no round-trip.
// Otherwise ask the server (GET /api/v1/game/link). Returns true (linked),
// false (definitively NOT linked), or null (couldn't check → caller fails
// open). Never blocks on an id we couldn't resolve.
async function isLinkedToFocus(name, toId) {
  const s = slice();
  const game = s.game;
  if (!game) return null;
  const focus = focusName(game);
  const fr = s.frontier;
  if (fr && !fr.loading && Array.isArray(fr.neighbours) &&
      fr.neighbours.some(n => (toId != null && n.id === toId) || eqName(n.name, name))) {
    return true;
  }
  const fromId = idFor(focus) ?? await resolveId(focus);
  const resolvedTo = toId ?? idFor(name) ?? await resolveId(name);
  if (s.game !== game) return null;
  if (fromId == null || resolvedTo == null) return null; // can't verify → fail open
  const verdict = await checkLink(fromId, resolvedTo);
  return verdict.linked;
}

// [design: живая проверка хода / game #2] Add via TYPING / picking from
// search / clicking the goal target — gated by the live connection check, so
// you can't drop an artist onto the web who never collaborated with the
// current focus. Frontier (dandelion) clicks skip this (selectBrowseNode →
// commitHop directly): those are already known collaborators. Fails OPEN
// (adds anyway) when the check can't be made — the server still validates the
// whole winning line at submit.
export async function commitTypedHop(name) {
  const s = slice();
  const game = s.game;
  if (!game) return null;
  const clean = String(name || "").trim();
  if (!clean) return null;
  if (eqName(clean, focusName(game))) return null;

  const linked = await isLinkedToFocus(clean, idFor(clean));
  if (s.game !== game) return null;
  if (linked === false) {
    showToast(`${clean} isn't a known collaborator of ${focusName(game)} — pick from the graph or try another.`, 4600);
    return { ok: false, reason: "unlinked" };
  }
  return commitHop(clean);
}

// [design: Lock in] Submit the finished line for scoring. No-op unless the
// line reaches the goal and hasn't already been locked in.
export function lockIn() {
  const s = slice();
  if (!s.game || !isComplete(s.game) || s.game.gaveUp || s.submitted) return;
  s.submitted = true;
  render();
  submitRound();
}

export function undoLast() { const s = slice(); if (s.game) { undoHop(s.game); s.submitted = false; render(); refreshFrontier(); } }
export function resetGame() { const s = slice(); if (s.game) { resetChain(s.game); s.submitted = false; render(); refreshFrontier(); } }

function selectBrowseNode(node) {
  setPhoto(node.name, node.image);
  setId(node.name, node.id);
  commitHop(node.name);
}

export function giveUpGame() {
  const s = slice();
  if (!s.game) return;
  modelGiveUp(s.game);
  s.frontier = null;
  render();
}

// [fix] Change used to reveal two BLANK fields even with both endpoints
// already known — real whenever the game was started somewhere other than
// typing directly into these two inputs (the landing panel's own duel/
// daily/rival flows all set State straight via setStartArtist/
// setGoalArtist, never touching connectStartInput/connectGoalInput's
// .value). Synced HERE, once, at the moment of actually expanding — not
// folded into the general renderEndpoints() render pass, which also runs
// mid-flow (e.g. right after setStartArtist but before setGoalArtist) and
// would otherwise blank out a field a caller (autocomplete pick, deep-link
// restore) had just deliberately set moments earlier.
export function expandEndpoints() {
  _endpointsExpanded = true;
  const s = slice();
  if (els.connectStartInput) els.connectStartInput.value = s.startName;
  if (els.connectGoalInput) els.connectGoalInput.value = s.goalName;
  render();
}

// [design: real backend] The chain just reached the goal — build the full
// id chain (resolving anything still unresolved) and submit for real.
async function submitRound() {
  const s = slice();
  const game = s.game;
  if (!game || !game.completed) return;
  if (!game.challengeId) {
    showToast("Couldn't verify this challenge — try again from a fresh start/goal pick.", 4800, true);
    render();
    return;
  }
  // [design: ветвящийся веб] Submit the WINNING LINE — the start→goal path
  // through the web — not the whole tree. Losing branches are just the
  // player's exploration; only the route that reached the goal is scored.
  const names = winningPath(game) || chainNodes(game);
  const ids = await Promise.all(names.map(resolveId));
  if (s.game !== game) return;
  if (ids.some(id => id == null)) {
    showToast("Couldn't identify one of the names in your chain, so this attempt can't be scored — the win still counts.", 5200, true);
    render();
    return;
  }
  render(); // shows "Scoring…"
  const response = await submitChain(game.challengeId, ids, elapsedMs(game));
  if (s.game !== game) return;
  if (!response) {
    showToast("Couldn't reach the game service to score this attempt.", 4800, true);
    render();
    return;
  }
  applyResult(game, response);
  render();
  if (response.valid === true) {
    const board = await fetchLeaderboard(game.challengeId);
    if (s.game === game && board) { applyLeaderboard(game, board); render(); }
  }
}

export function _currentChain() { return slice().game; }

// ── Wiring ───────────────────────────────────────────────────────────────

function commitField(inputEl, apply) {
  const v = (inputEl?.value || "").trim();
  if (v) apply(v);
}

// Module-scope, not per-call — setupConnectMode can run more than once in
// a test harness, and the window resize listener should still only ever
// be registered the first time.
let _wired = false;

export function setupConnectMode() {
  if (!els.connectSurface) return;

  if (els.connectStartInput) {
    attachGeniusAutocomplete(els.connectStartInput, els.connectStartAc,
      (name, image, id) => { els.connectStartInput.value = name; setPhoto(name, image); setId(name, id); setStartArtist(name); });
    els.connectStartInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitField(els.connectStartInput, setStartArtist); }
    });
  }
  if (els.connectGoalInput) {
    attachGeniusAutocomplete(els.connectGoalInput, els.connectGoalAc,
      (name, image, id) => { els.connectGoalInput.value = name; setPhoto(name, image); setId(name, id); setGoalArtist(name); });
    els.connectGoalInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitField(els.connectGoalInput, setGoalArtist); }
    });
  }
  if (els.connectAddInput) {
    // [game #2] Typed / picked adds go through the live connection check
    // (commitTypedHop); clicking a dandelion collaborator does not (it's
    // already a known collaborator of the focus — selectBrowseNode).
    attachGeniusAutocomplete(els.connectAddInput, els.connectAddAc,
      (name, image, id) => { setPhoto(name, image); setId(name, id); commitTypedHop(name); });
    els.connectAddInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitTypedHop(els.connectAddInput.value); }
    });
  }
  els.connectAddBtn?.addEventListener("click", () => commitTypedHop(els.connectAddInput?.value));

  els.connectUndo?.addEventListener("click", undoLast);
  els.connectReset?.addEventListener("click", resetGame);
  els.connectGiveUp?.addEventListener("click", giveUpGame);
  els.connectShare?.addEventListener("click", shareCurrentChallenge);
  els.connectLockin?.addEventListener("click", lockIn);
  els.connectEndpointsSummary?.addEventListener("click", expandEndpoints);

  // [design: граф-эксплорер с рейлом] Zoom/fit rail over the live graph.
  els.connectZoomIn?.addEventListener("click", () => zoomBoard(1.25));
  els.connectZoomOut?.addEventListener("click", () => zoomBoard(0.8));
  els.connectFit?.addEventListener("click", fitBoard);

  // [design: ветвящийся веб] Clicking a line row re-focuses that node — the
  // same branch action as clicking the node on the graph.
  els.connectLineList?.addEventListener("click", e => {
    const row = e.target.closest(".clp-row");
    if (row && row.dataset.name) focusNodeByName(row.dataset.name);
  });

  els.connectBrowseChips?.addEventListener("click", e => {
    const btn = e.target.closest(".cb-chip");
    if (!btn) return;
    const s = slice();
    const id = Number(btn.dataset.id);
    const node = s.frontier?.neighbours.find(n => n.id === id);
    if (node) selectBrowseNode(node);
  });

  if (!_wired) {
    _wired = true;
    window.addEventListener("resize", () => { if (getCurrentSurface() === SURFACE_GAME) draw(); });
  }

  const applySurface = surface => {
    const on = surface === SURFACE_GAME;
    els.connectSurface.classList.toggle("show", on);
    els.connectSurface.hidden = !on;
    if (on) {
      // [design: настоящий граф] Move the real #network into the game's graph
      // column and switch it into restricted game mode, then render the board.
      mountBoard(els.connectCanvas);
      requestAnimationFrame(draw);
    } else {
      // Leaving the game: hand #network back to the Explorer canvas and drop
      // the interaction restriction.
      unmountBoard();
    }
  };
  onSurfaceChange(applySurface);
  applySurface(getCurrentSurface());

  // [SF-GAME-05] Landing directly on a shared link (#/game?from=..&to=..) —
  // same one-shot-at-setup posture as main.js's own loadArtistFromUrl() for
  // the graph surface. Pre-filling both fields drives the exact same
  // create-or-get challenge flow a manual type-in would (see syncGame/
  // ensureChallenge above) — nothing deep-link-specific downstream.
  if (getCurrentSurface() === SURFACE_GAME && !slice().game) {
    const { from, to } = parseGameShareState(window.location.search);
    if (from && to) {
      if (els.connectStartInput) els.connectStartInput.value = from;
      if (els.connectGoalInput) els.connectGoalInput.value = to;
      setStartArtist(from);
      setGoalArtist(to);
    }
  }

  render();
}

// ════════════════════════════════════════════════════════════════════════════
// [design: challenge setup on the landing page] Game's own in-place hero
// panel — a "vs" duel, deliberately NOT Connect's route-track sitting right
// next to it (feedback: the two read as the same trick reused). Wired the
// same way Connect's own hero panel is: real autocomplete on both fields,
// one CTA that hands off to the exact setStartArtist/setGoalArtist +
// navigateToSurface flow SF-GAME-05's deep link already uses — landing on
// #/game with both endpoints already set, nothing to redo there.
// ════════════════════════════════════════════════════════════════════════════

function renderDuelAvatar(el, name, image) {
  if (!el) return;
  el.innerHTML = image ? `<img src="${escapeHtml(image)}" alt="" />` : "";
  if (!image) el.textContent = name ? initialOf(name) : "?";
}

function startChallengeFromLanding() {
  const from = (els.heroGameFromInput?.value || "").trim();
  const to = (els.heroGameToInput?.value || "").trim();
  if (!from || !to) { showToast("Enter both artist names."); return; }
  setStartArtist(from);
  setGoalArtist(to);
  navigateToSurface(SURFACE_GAME);
}

export function setupGameLandingPanel() {
  if (els.heroGameFromInput) {
    attachGeniusAutocomplete(els.heroGameFromInput, els.heroGameFromAc,
      (name, image, id) => {
        els.heroGameFromInput.value = name;
        setPhoto(name, image); setId(name, id);
        renderDuelAvatar(els.heroGameFromAvatar, name, image);
      });
    els.heroGameFromInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); els.heroGameToInput?.focus(); }
    });
  }
  if (els.heroGameToInput) {
    attachGeniusAutocomplete(els.heroGameToInput, els.heroGameToAc,
      (name, image, id) => {
        els.heroGameToInput.value = name;
        setPhoto(name, image); setId(name, id);
        renderDuelAvatar(els.heroGameToAvatar, name, image);
      });
    els.heroGameToInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); startChallengeFromLanding(); }
    });
  }
  els.btnHeroStartChallenge?.addEventListener("click", startChallengeFromLanding);

  loadTodaysChallenge();
}

// ── [design: Today's Challenge + or pick a rival] ────────────────────────────
// Real GET /api/v1/game/challenge?daily=1 + GET /api/v1/game/leaderboard?
// challenge_id=<daily.id> (SF-GAME-17, unchanged) — no mock data, no
// placeholder card shown while loading. Both stay hidden (their index.html
// markup starts `hidden`) until real data resolves; a 404 (no daily
// challenge published yet in this environment) or a network failure just
// leaves the composer as the only option, same as before this feature
// existed — never a broken-looking empty card.
let _daily = null;

// [game #3] Start any challenge from its already-resolved endpoints — the
// shared path behind the landing daily/rival cards AND the challenge-browser
// window (game-windows.js). from/to are { name, id?, image? }; feeding the
// id/photo caches means play never re-resolves either name via /api/v1/
// search. `rival` optionally carries a leaderboard entry to chase.
export function startChallengeByRefs(from, to, rival) {
  if (!from || !from.name || !to || !to.name) return;
  if (from.id != null) setId(from.name, from.id);
  if (from.image) setPhoto(from.name, from.image);
  if (to.id != null) setId(to.name, to.id);
  if (to.image) setPhoto(to.name, to.image);
  setStartArtist(from.name);
  setGoalArtist(to.name);
  if (rival) slice().rivalBanner = { name: rival.display_name, score: rival.score };
  navigateToSurface(SURFACE_GAME);
}

function startDailyChallenge(rival) {
  if (!_daily) return;
  startChallengeByRefs(
    { name: _daily.from_name, id: _daily.from, image: _daily.from_image },
    { name: _daily.to_name,   id: _daily.to,   image: _daily.to_image },
    rival);
}

function renderDailyCard(daily) {
  if (!els.heroGameDaily) return;
  els.heroGameDaily.hidden = false;
  renderDuelAvatar(els.heroGameDailyFromAvatar, daily.from_name, daily.from_image);
  renderDuelAvatar(els.heroGameDailyToAvatar, daily.to_name, daily.to_image);
  if (els.heroGameDailyFromName) els.heroGameDailyFromName.textContent = daily.from_name;
  if (els.heroGameDailyToName) els.heroGameDailyToName.textContent = daily.to_name;
  if (els.heroGameDivider) els.heroGameDivider.hidden = false;
}

function renderRivals(entries) {
  if (!els.heroGameRivals || !els.heroGameRivalsList || !entries.length) return;
  els.heroGameRivals.hidden = false;
  els.heroGameRivalsList.innerHTML = entries.map((e, i) =>
    `<button type="button" class="rival-chip" data-idx="${i}">` +
    `<span class="rc-rank">#${i + 1}</span>` +
    `<span class="rc-name">${escapeHtml(e.display_name)}</span>` +
    `<span class="rc-score">${e.score}</span></button>`
  ).join("");
  els.heroGameRivalsList.querySelectorAll(".rival-chip").forEach(btn => {
    btn.addEventListener("click", () => startDailyChallenge(entries[Number(btn.dataset.idx)]));
  });
}

async function loadTodaysChallenge() {
  const daily = await fetchDailyChallenge();
  if (!daily) return; // no daily challenge published yet / unreachable — composer stays the only option
  _daily = daily;
  renderDailyCard(daily);
  els.btnHeroPlayDaily?.addEventListener("click", () => startDailyChallenge(null));

  const page = await fetchLeaderboard(daily.id);
  if (page?.entries?.length) renderRivals(page.entries);
}
