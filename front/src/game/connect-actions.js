import { els } from "../dom/dom.js";
import { navigateToSurface, SURFACE_GAME } from "../ui/router.js";
import { showToast } from "../ui/toast.js";
import {
  createConnectChain,
  chainNodes,
  isComplete,
  addHop,
  undoHop,
  resetChain,
  giveUp as modelGiveUp,
  pathRevealed,
  elapsedMs,
  setChallengeId,
  applyResult,
  applyLeaderboard,
  winningPath,
  focusName,
  setFocus,
} from "./connect-model.js";
import {
  slice,
  setPhoto,
  setId,
  idFor,
  eqName,
  endpointsReady,
  resolveId,
  clearUnresolved,
  serializeGameShareState,
} from "./connect-store.js";
import { render, draw, setEndpointsExpanded, setBoardHandlers } from "./connect-view.js";
import { fetchNeighbours } from "./game-graph.js";
import { createChallenge, submitChain, fetchLeaderboard, checkLink } from "./game-api.js";

function syncGame() {
  const s = slice();
  s.game = endpointsReady() ? createConnectChain(s.startName, s.goalName) : null;
  setEndpointsExpanded(false);
  s.frontier = null;
  s.par = null;
  s.submitted = false;
  s.rivalBanner = null;
  clearUnresolved();
  if (s.game) ensureChallenge();
}

async function ensureChallenge() {
  const s = slice();
  const game = s.game;
  if (!game) return;
  const [fromId, toId] = await Promise.all([resolveId(game.start), resolveId(game.goal)]);
  if (s.game !== game) return;
  if (fromId == null || toId == null) {
    render();
    return;
  }
  const challenge = await createChallenge(fromId, toId, 0);
  if (s.game !== game) return;
  if (challenge && challenge.id) setChallengeId(game, challenge.id);
  if (challenge && challenge.optimal_len != null) s.par = challenge.optimal_len;
  if (challenge && challenge.season_id != null) s.seasonId = challenge.season_id;
  render();
}

let _frontierToken = 0;

async function refreshFrontier() {
  const s = slice();
  if (!s.game || pathRevealed(s.game)) {
    s.frontier = null;
    render();
    return;
  }
  const tail = focusName(s.game);
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

async function submitRound() {
  const s = slice();
  const game = s.game;
  if (!game || !game.completed) return;
  if (!game.challengeId) {
    showToast(
      "Couldn't verify this challenge — try again from a fresh start/goal pick.",
      4800,
      true,
    );
    render();
    return;
  }
  const names = winningPath(game) || chainNodes(game);
  const ids = await Promise.all(names.map(resolveId));
  if (s.game !== game) return;
  if (ids.some((id) => id == null)) {
    showToast(
      "Couldn't identify one of the names in your chain, so this attempt can't be scored — the win still counts.",
      5200,
      true,
    );
    render();
    return;
  }
  render();
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
    if (s.game === game && board) {
      applyLeaderboard(game, board);
      render();
    }
  }
}

export function setStartArtist(name) {
  slice().startName = String(name || "");
  syncGame();
  render();
  refreshFrontier();
}
export function setGoalArtist(name) {
  slice().goalName = String(name || "");
  syncGame();
  render();
  refreshFrontier();
}

export function commitHop(name) {
  const s = slice();
  if (!s.game) return null;
  const res = addHop(s.game, name);
  if (res.ok && els.connectAddInput) els.connectAddInput.value = "";
  if (res.ok && res.completed) s.submitted = false;
  render();
  if (res.ok && !res.completed) {
    resolveId(name);
    refreshFrontier();
  }
  return res;
}

async function isLinkedToFocus(name, toId) {
  const s = slice();
  const game = s.game;
  if (!game) return null;
  const focus = focusName(game);
  const fr = s.frontier;
  if (
    fr &&
    !fr.loading &&
    Array.isArray(fr.neighbours) &&
    fr.neighbours.some((n) => (toId != null && n.id === toId) || eqName(n.name, name))
  ) {
    return true;
  }
  const fromId = idFor(focus) ?? (await resolveId(focus));
  const resolvedTo = toId ?? idFor(name) ?? (await resolveId(name));
  if (s.game !== game) return null;
  if (fromId == null || resolvedTo == null) return null;
  const verdict = await checkLink(fromId, resolvedTo);
  return verdict.linked;
}

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
    showToast(
      `${clean} isn't a known collaborator of ${focusName(game)} — pick from the graph or try another.`,
      4600,
    );
    return { ok: false, reason: "unlinked" };
  }
  return commitHop(clean);
}

export function lockIn() {
  const s = slice();
  if (!s.game || !isComplete(s.game) || s.game.gaveUp || s.submitted) return;
  s.submitted = true;
  render();
  submitRound();
}

export function undoLast() {
  const s = slice();
  if (s.game) {
    undoHop(s.game);
    s.submitted = false;
    render();
    refreshFrontier();
  }
}
export function resetGame() {
  const s = slice();
  if (s.game) {
    resetChain(s.game);
    s.submitted = false;
    render();
    refreshFrontier();
  }
}

export function giveUpGame() {
  const s = slice();
  if (!s.game) return;
  modelGiveUp(s.game);
  s.frontier = null;
  render();
}

export function focusNodeByName(name) {
  const s = slice();
  if (!s.game) return;
  if (setFocus(s.game, name).ok) {
    render();
    refreshFrontier();
  }
}

export function selectBrowseNode(node) {
  setPhoto(node.name, node.image);
  setId(node.name, node.id);
  commitHop(node.name);
}

export function startFromSetup() {
  const from = (els.connectStartInput?.value || "").trim();
  const to = (els.connectGoalInput?.value || "").trim();
  if (!from || !to) {
    showToast("Pick both artists first.");
    return;
  }
  setStartArtist(from);
  setGoalArtist(to);
}

export function expandEndpoints() {
  setEndpointsExpanded(true);
  const s = slice();
  if (els.connectStartInput) els.connectStartInput.value = s.startName;
  if (els.connectGoalInput) els.connectGoalInput.value = s.goalName;
  render();
}

export function shareCurrentChallenge() {
  const s = slice();
  if (!s.game) return;
  const url = new URL(window.location.href);
  url.hash = "#/game";
  url.search = serializeGameShareState({ from: s.game.start, to: s.game.goal }).toString();
  const link = url.toString();
  const write = navigator.clipboard?.writeText?.(link);
  if (!write || typeof write.then !== "function") {
    showToast(`Copy: ${link}`, 6000);
    return;
  }
  write
    .then(() => showToast("🔗 Link copied!", 2000, true))
    .catch(() => showToast(`Copy: ${link}`, 6000));
}

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

export function _currentChain() {
  return slice().game;
}

setBoardHandlers({
  onPick: selectBrowseNode,
  onFocus: focusNodeByName,
  onReachGoal: () => {
    const g = slice().game;
    if (g) commitTypedHop(g.goal);
  },
});

export { draw, refreshFrontier };
