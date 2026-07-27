import { els } from "../dom/dom.js";
import { escapeHtml, initialOf } from "../state/helpers.js";
import {
  chainNodes,
  hopCount,
  isComplete,
  webSize,
  pathRevealed,
  elapsedMs,
  resultView,
  leaderboardView,
  focusName,
} from "./connect-model.js";
import { slice, idFor, endpointsReady, unresolvedNames } from "./connect-store.js";
import { renderBoard } from "./game-board.js";

let _boardHandlers = {};
export function setBoardHandlers(handlers) {
  _boardHandlers = handlers || {};
}

let _endpointsExpanded = false;
export function setEndpointsExpanded(on) {
  _endpointsExpanded = !!on;
}

function renderHead() {
  const s = slice();
  if (els.connectTitleStart)
    els.connectTitleStart.textContent = s.game ? s.game.start : s.startName || "Start";
  if (els.connectTitleGoal)
    els.connectTitleGoal.textContent = s.game ? s.game.goal : s.goalName || "Goal";
  if (els.connectHopsValue)
    els.connectHopsValue.textContent = s.game ? String(hopCount(s.game)) : "0";

  const poleName = (el, name) => {
    if (el) el.textContent = name || "—";
  };
  const poleAv = (el, name) => {
    if (!el) return;
    const photo = name ? s.photos[name] : null;
    el.innerHTML = photo
      ? `<img src="${escapeHtml(photo)}" alt="" />`
      : escapeHtml(name ? initialOf(name) : "?");
  };
  const fromName = s.game ? s.game.start : s.startName;
  const toName = s.game ? s.game.goal : s.goalName;
  poleName(els.connectPoleFromName, fromName);
  poleName(els.connectPoleToName, toName);
  poleAv(els.connectPoleFrom, fromName);
  poleAv(els.connectPoleTo, toName);

  if (els.connectParPill) {
    const showPar = s.game && s.par != null;
    els.connectParPill.hidden = !showPar;
    if (showPar && els.connectParValue) els.connectParValue.textContent = String(s.par);
  }

  if (els.connectProgress) {
    const par = s.game ? s.par : null;
    const show = !!s.game && par != null && par > 0;
    els.connectProgress.hidden = !show;
    if (show) {
      const hops = hopCount(s.game);
      const over = Math.max(0, hops - par);
      if (els.connectPips) {
        els.connectPips.innerHTML = Array.from({ length: par + over }, (_, i) => {
          const cls = i >= par ? "is-over" : i < hops ? "is-done" : "";
          return `<span class="clp-pip ${cls}"></span>`;
        }).join("");
      }
      if (els.connectProgressLabel) {
        els.connectProgressLabel.textContent =
          over > 0 ? `${hops} / ${par} · +${over} over par` : `${hops} / ${par} to par`;
        els.connectProgressLabel.classList.toggle("is-over", over > 0);
      }
    }
  }

  if (els.connectRivalPill) {
    const rival = s.game ? s.rivalBanner : null;
    els.connectRivalPill.hidden = !rival;
    if (rival && els.connectRivalText) {
      els.connectRivalText.textContent = `Chasing ${rival.name} · ${rival.score}`;
    }
  }
}

let _lastLineLen = 0;

function renderLine() {
  const s = slice();
  if (!els.connectLineList) return;
  if (!s.game) {
    els.connectLineList.innerHTML = "";
    _lastLineLen = 0;
    return;
  }
  const game = s.game;
  const names = chainNodes(game);
  const focus = focusName(game);
  const grew = names.length > _lastLineLen;
  _lastLineLen = names.length;
  const rows = names
    .map((name, i) => {
      const isNew = grew && i === names.length - 1;
      const isStart = name === game.start,
        isGoal = name === game.goal;
      const role = isStart ? "start" : isGoal ? "goal" : "hop";
      const isFocus = name === focus;
      const photo = s.photos[name];
      const avatar = photo
        ? `<img class="clp-av" src="${escapeHtml(photo)}" alt="" />`
        : `<span class="clp-av clp-av--${role}">${escapeHtml(initialOf(name))}</span>`;
      const sub = isStart
        ? "the origin"
        : isGoal
          ? game.completed
            ? "reached"
            : "the target"
          : isFocus
            ? "branching from here"
            : "collaborator";
      return (
        `<li class="clp-row clp-row--${role}${isFocus ? " is-focus" : ""}${isNew ? " is-new" : ""}" data-name="${escapeHtml(name)}">${avatar}` +
        `<span class="clp-row-main"><span class="clp-row-name">${escapeHtml(name)}</span>` +
        `<span class="clp-row-sub">${sub}</span></span></li>`
      );
    })
    .join("");
  const goalGhost = names.includes(game.goal)
    ? ""
    : `<li class="clp-row clp-row--goal is-ghost">` +
      `<span class="clp-av clp-av--goal">${escapeHtml(initialOf(game.goal))}</span>` +
      `<span class="clp-row-main"><span class="clp-row-name">${escapeHtml(game.goal)}</span>` +
      `<span class="clp-row-sub">the target</span></span></li>`;

  const offBranch = webSize(game) - Math.max(0, names.length - 1);
  const note =
    offBranch > 0
      ? `<li class="clp-web-note">+${offBranch} on other branch${offBranch === 1 ? "" : "es"} — click any node to jump there</li>`
      : "";
  els.connectLineList.innerHTML = rows + goalGhost + note;
  const focusCard = els.connectLineList.querySelector(".clp-row.is-focus");
  if (focusCard && typeof focusCard.scrollIntoView === "function") {
    focusCard.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function renderEndpoints() {
  const s = slice();
  const editing = !s.game || _endpointsExpanded || !endpointsReady();
  if (els.connectEndpoints) els.connectEndpoints.hidden = !editing;
  els.connectSurface?.classList.toggle("has-game", !!s.game);
}

export function draw() {
  const s = slice();
  renderBoard(s.game, s.photos, s.frontier, s.ids, _boardHandlers, { par: s.par });
}

function renderStage() {
  const s = slice();
  const stuck = s.game
    ? unresolvedNames().filter((n) => n === s.game.start || n === s.game.goal)
    : [];
  if (els.connectStageEmpty) {
    els.connectStageEmpty.hidden = !s.game || stuck.length === 0;
    if (s.game && stuck.length) {
      els.connectStageEmpty.textContent =
        stuck.length === 1
          ? `Couldn't find “${stuck[0]}” on Genius — pick the artist from the suggestions instead of typing the name.`
          : `Couldn't find ${stuck.map((n) => `“${n}”`).join(" or ")} on Genius — pick both artists from the suggestions.`;
    }
  }
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

function renderBrowse() {
  const s = slice();
  if (!els.connectBrowse) return;
  if (!s.game || pathRevealed(s.game) || !s.frontier) {
    els.connectBrowse.hidden = true;
    if (els.connectBrowseChips) els.connectBrowseChips.innerHTML = "";
    return;
  }
  els.connectBrowse.hidden = false;
  if (els.connectBrowseLabel)
    els.connectBrowseLabel.textContent = `Or browse ${s.frontier.centerName}'s real collaborators`;
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
  els.connectBrowseChips.innerHTML = f.neighbours
    .map((n) => {
      const isGoal = goalId != null && n.id === goalId;
      const ini = n.name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const avatar = n.image
        ? `<img class="cb-avatar" src="${escapeHtml(n.image)}" alt="" />`
        : `<span class="cb-avatar cb-avatar--fallback">${escapeHtml(ini)}</span>`;
      return (
        `<button type="button" class="ui-chip cb-chip${isGoal ? " cb-chip--goal" : ""}" data-id="${n.id}">` +
        avatar +
        `<span class="cb-name">${escapeHtml(n.name)}</span></button>`
      );
    })
    .join("");
}

function renderMiniActions() {
  const s = slice();
  const active = !!s.game;
  const completed = active && isComplete(s.game);
  if (els.connectUndo) els.connectUndo.disabled = !active || (hopCount(s.game) === 0 && !completed);
  if (els.connectReset)
    els.connectReset.disabled = !active || (hopCount(s.game) === 0 && !completed);
  if (els.connectGiveUp)
    els.connectGiveUp.disabled = !active || completed || s.game.gaveUp || hopCount(s.game) === 0;
  if (els.connectShare) els.connectShare.disabled = !active;
}

function renderLockin() {
  const s = slice();
  if (!els.connectLockin) return;
  const complete = s.game && isComplete(s.game) && !s.game.gaveUp;
  els.connectLockin.disabled = !complete || s.submitted;
  els.connectLockin.textContent = s.submitted ? "Locked in" : "Lock in";
}

function renderFinish() {
  const s = slice();
  const scoreEl = els.connectFinishScore,
    labelEl = els.connectFinishLabel,
    detailEl = els.connectFinishDetail;
  const setLabel = (t) => {
    if (labelEl) labelEl.textContent = t || "";
  };
  const setScore = (t) => {
    if (!scoreEl || scoreEl.textContent === String(t)) return;
    scoreEl.textContent = t;
    scoreEl.classList.remove("is-bumped");
    void scoreEl.offsetWidth;
    scoreEl.classList.add("is-bumped");
  };
  const hideDetail = () => {
    if (detailEl) detailEl.hidden = true;
  };

  if (!s.game) {
    setScore("—");
    setLabel("");
    hideDetail();
    return;
  }

  const view = resultView(s.game);

  if (s.game.gaveUp && !view) {
    setScore("—");
    setLabel("You gave up — no score for this attempt.");
    hideDetail();
    return;
  }

  if (!s.submitted && !view) {
    setScore("—");
    setLabel("");
    hideDetail();
    return;
  }

  if (!view) {
    setScore("…");
    setLabel("Scoring…");
    hideDetail();
    return;
  }

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
  const rows = view.entries
    .map(
      (e, i) =>
        `<div class="cl-row"><span class="cl-rank">${i + 1}</span>` +
        `<span class="cl-name">${escapeHtml(e.displayName)}</span>` +
        `<span class="cl-score">${e.score}</span></div>`,
    )
    .join("");
  els.connectLeaderboard.innerHTML = `<h4 class="connect-leaderboard-title">Leaderboard</h4>${rows}`;
}

let _tickHandle = null;
function renderTimer() {
  const s = slice();
  if (!els.connectTimerValue) return;
  els.connectTimerValue.textContent = s.game ? formatElapsed(elapsedMs(s.game)) : "0:00";
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function ensureTicking() {
  const s = slice();
  const shouldTick = !!(s.game && !s.game.finishedAt);
  if (shouldTick && !_tickHandle) _tickHandle = setInterval(renderTimer, 500);
  else if (!shouldTick && _tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
  }
}

export function render() {
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
