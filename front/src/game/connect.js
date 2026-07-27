import { els } from "../dom/dom.js";
import { escapeHtml, initialOf } from "../state/helpers.js";
import {
  navigateToSurface,
  onSurfaceChange,
  getCurrentSurface,
  SURFACE_GAME,
} from "../ui/router.js";
import { attachGeniusAutocomplete } from "../ui/autocomplete.js";
import { showToast } from "../ui/toast.js";
import { zoomBoard, fitBoard, mountBoard, unmountBoard } from "./game-board.js";
import { fetchDailyChallengeState, fetchLeaderboard } from "./game-api.js";
import { slice, setPhoto, setId, parseGameShareState } from "./connect-store.js";
import { render, draw } from "./connect-view.js";
import {
  setStartArtist,
  setGoalArtist,
  commitTypedHop,
  undoLast,
  resetGame,
  giveUpGame,
  lockIn,
  expandEndpoints,
  focusNodeByName,
  selectBrowseNode,
  shareCurrentChallenge,
  startChallengeByRefs,
  startFromSetup,
} from "./connect-actions.js";

export {
  setStartArtist,
  setGoalArtist,
  commitHop,
  commitTypedHop,
  undoLast,
  resetGame,
  giveUpGame,
  lockIn,
  expandEndpoints,
  shareCurrentChallenge,
  startChallengeByRefs,
  startFromSetup,
  _currentChain,
} from "./connect-actions.js";
export { serializeGameShareState, parseGameShareState } from "./connect-store.js";

function inSetup() {
  return !slice().game;
}

function commitField(inputEl, apply) {
  const v = (inputEl?.value || "").trim();
  if (!v) return;
  if (inSetup()) {
    startFromSetup();
    return;
  }
  apply(v);
}

function pickEndpoint(inputEl, apply) {
  return (name, image, id) => {
    inputEl.value = name;
    setPhoto(name, image);
    setId(name, id);
    if (inSetup()) syncSetupCta();
    else apply(name);
  };
}

function syncSetupCta() {
  if (!els.connectStartBtn) return;
  const from = (els.connectStartInput?.value || "").trim();
  const to = (els.connectGoalInput?.value || "").trim();
  els.connectStartBtn.disabled = !(from && to);
}

let _wired = false;

export function setupConnectMode() {
  if (!els.connectSurface) return;

  if (els.connectStartInput) {
    attachGeniusAutocomplete(
      els.connectStartInput,
      els.connectStartAc,
      pickEndpoint(els.connectStartInput, setStartArtist),
    );
    els.connectStartInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitField(els.connectStartInput, setStartArtist);
      }
    });
    els.connectStartInput.addEventListener("input", syncSetupCta);
  }
  if (els.connectGoalInput) {
    attachGeniusAutocomplete(
      els.connectGoalInput,
      els.connectGoalAc,
      pickEndpoint(els.connectGoalInput, setGoalArtist),
    );
    els.connectGoalInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitField(els.connectGoalInput, setGoalArtist);
      }
    });
    els.connectGoalInput.addEventListener("input", syncSetupCta);
  }
  syncSetupCta();
  if (els.connectAddInput) {
    attachGeniusAutocomplete(els.connectAddInput, els.connectAddAc, (name, image, id) => {
      setPhoto(name, image);
      setId(name, id);
      commitTypedHop(name);
    });
    els.connectAddInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitTypedHop(els.connectAddInput.value);
      }
    });
  }
  els.connectAddBtn?.addEventListener("click", () => commitTypedHop(els.connectAddInput?.value));

  els.connectUndo?.addEventListener("click", undoLast);
  els.connectReset?.addEventListener("click", resetGame);
  els.connectGiveUp?.addEventListener("click", giveUpGame);
  els.connectShare?.addEventListener("click", shareCurrentChallenge);
  els.connectLockin?.addEventListener("click", lockIn);
  els.connectEndpointsSummary?.addEventListener("click", expandEndpoints);
  els.connectStartBtn?.addEventListener("click", startFromSetup);

  els.connectZoomIn?.addEventListener("click", () => zoomBoard(1.25));
  els.connectZoomOut?.addEventListener("click", () => zoomBoard(0.8));
  els.connectFit?.addEventListener("click", fitBoard);

  els.connectLineList?.addEventListener("click", (e) => {
    const row = e.target.closest(".clp-row");
    if (row && row.dataset.name) focusNodeByName(row.dataset.name);
  });

  els.connectBrowseChips?.addEventListener("click", (e) => {
    const btn = e.target.closest(".cb-chip");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const node = slice().frontier?.neighbours.find((n) => n.id === id);
    if (node) selectBrowseNode(node);
  });

  if (!_wired) {
    _wired = true;
    window.addEventListener("resize", () => {
      if (getCurrentSurface() === SURFACE_GAME) draw();
    });
  }

  const applySurface = (surface) => {
    const on = surface === SURFACE_GAME;
    els.connectSurface.classList.toggle("show", on);
    els.connectSurface.hidden = !on;
    if (on) {
      mountBoard(els.connectCanvas);
      syncSetupCta();
      requestAnimationFrame(draw);
    } else {
      unmountBoard();
    }
  };
  onSurfaceChange(applySurface);
  applySurface(getCurrentSurface());

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

function renderDuelAvatar(el, name, image) {
  if (!el) return;
  el.innerHTML = image ? `<img src="${escapeHtml(image)}" alt="" />` : "";
  if (!image) el.textContent = name ? initialOf(name) : "?";
}

function startChallengeFromLanding() {
  const from = (els.heroGameFromInput?.value || "").trim();
  const to = (els.heroGameToInput?.value || "").trim();
  if (!from || !to) {
    showToast("Enter both artist names.");
    return;
  }
  setStartArtist(from);
  setGoalArtist(to);
  navigateToSurface(SURFACE_GAME);
}

export function setupGameLandingPanel() {
  if (els.heroGameFromInput) {
    attachGeniusAutocomplete(els.heroGameFromInput, els.heroGameFromAc, (name, image, id) => {
      els.heroGameFromInput.value = name;
      setPhoto(name, image);
      setId(name, id);
      renderDuelAvatar(els.heroGameFromAvatar, name, image);
    });
    els.heroGameFromInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        els.heroGameToInput?.focus();
      }
    });
  }
  if (els.heroGameToInput) {
    attachGeniusAutocomplete(els.heroGameToInput, els.heroGameToAc, (name, image, id) => {
      els.heroGameToInput.value = name;
      setPhoto(name, image);
      setId(name, id);
      renderDuelAvatar(els.heroGameToAvatar, name, image);
    });
    els.heroGameToInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startChallengeFromLanding();
      }
    });
  }
  els.btnHeroStartChallenge?.addEventListener("click", startChallengeFromLanding);
  els.btnHeroPlayDaily?.addEventListener("click", () => startDailyChallenge(null));
  els.btnHeroDailyRetry?.addEventListener("click", () => loadTodaysChallenge());
  els.btnHeroGameSwap?.addEventListener("click", () => {
    const a = els.heroGameFromInput,
      b = els.heroGameToInput;
    if (!a || !b) return;
    [a.value, b.value] = [b.value, a.value];
    const fa = els.heroGameFromAvatar,
      fb = els.heroGameToAvatar;
    if (fa && fb) {
      const t = fa.innerHTML;
      fa.innerHTML = fb.innerHTML;
      fb.innerHTML = t;
    }
    a.focus();
  });

  loadTodaysChallenge();
}

let _daily = null;

function startDailyChallenge(rival) {
  if (!_daily) return;
  startChallengeByRefs(
    { name: _daily.from_name, id: _daily.from, image: _daily.from_image },
    { name: _daily.to_name, id: _daily.to, image: _daily.to_image },
    rival,
  );
}

function renderDailyState(state, daily) {
  const pair = els.heroGameDailyPair,
    line = els.heroGameDailyState;
  const play = els.btnHeroPlayDaily,
    retry = els.btnHeroDailyRetry;
  const showPair = state === "ok";
  if (pair) pair.hidden = !showPair;
  if (play) play.hidden = !showPair;
  if (retry) retry.hidden = state !== "unavailable";
  if (line) {
    line.hidden = showPair;
    line.textContent =
      state === "loading"
        ? "Loading today's challenge…"
        : state === "none"
          ? "No challenge published for today yet — set your own pair below."
          : "Couldn't reach the game service — today's challenge isn't loaded, not missing.";
    line.classList.toggle("is-error", state === "unavailable");
  }
  if (els.heroGameDivider) els.heroGameDivider.hidden = false;
  if (!showPair || !daily) return;
  renderDuelAvatar(els.heroGameDailyFromAvatar, daily.from_name, daily.from_image);
  renderDuelAvatar(els.heroGameDailyToAvatar, daily.to_name, daily.to_image);
  if (els.heroGameDailyFromName) els.heroGameDailyFromName.textContent = daily.from_name;
  if (els.heroGameDailyToName) els.heroGameDailyToName.textContent = daily.to_name;
}

function renderRivals(entries) {
  if (!els.heroGameRivals || !els.heroGameRivalsList || !entries.length) return;
  els.heroGameRivals.hidden = false;
  els.heroGameRivalsList.innerHTML = entries
    .map(
      (e, i) =>
        `<button type="button" class="ui-chip rival-chip" data-idx="${i}">` +
        `<span class="rc-rank">#${i + 1}</span>` +
        `<span class="rc-name">${escapeHtml(e.display_name)}</span>` +
        `<span class="rc-score">${e.score}</span></button>`,
    )
    .join("");
  els.heroGameRivalsList.querySelectorAll(".rival-chip").forEach((btn) => {
    btn.addEventListener("click", () => startDailyChallenge(entries[Number(btn.dataset.idx)]));
  });
}

async function loadTodaysChallenge() {
  renderDailyState("loading");
  const { status, daily } = await fetchDailyChallengeState();
  renderDailyState(status, daily);
  if (status !== "ok" || !daily) return;
  _daily = daily;

  const page = await fetchLeaderboard(daily.id);
  if (page?.entries?.length) renderRivals(page.entries);
}
