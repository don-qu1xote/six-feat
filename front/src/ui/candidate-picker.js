// ════════════════════════════════════════════════════════════════════════════
// ui/candidate-picker.js — Ambiguous-artist-name disambiguation overlay
// ════════════════════════════════════════════════════════════════════════════
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { searchArtist } from "../api/api.js";

export function showCandidatePicker(candidates, originalQuery) {
  if (!els.candidateOverlay || !els.candidateList) return;

  const titleEl = els.candidateOverlay.querySelector(".candidate-title");
  if (titleEl) {
    titleEl.textContent = originalQuery
      ? `A few "${originalQuery}"s exist — which one?`
      : "A few artists match — which one?";
  }

  els.candidateList.innerHTML = candidates.slice(0, 6).map(c => {
    const imgSrc = c.image || placeholderFor(c.name, false);
    const score  = c.score != null ? Math.round(c.score * 100) : "";
    return `<div class="candidate-item" data-name="${escapeHtml(c.name)}">
      <img class="candidate-avatar" src="${escapeHtml(imgSrc)}"
           data-fallback="${escapeHtml(placeholderFor(c.name, false))}" alt="" />
      <div class="candidate-info">
        <div class="candidate-name">${escapeHtml(c.name)}</div>
        ${score ? `<div class="candidate-score">${score}% match for "${escapeHtml(originalQuery)}"</div>` : ""}
      </div>
    </div>`;
  }).join("");

  els.candidateList.querySelectorAll(".candidate-item").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.getAttribute("data-name");
      hideCandidatePicker();
      searchArtist(name, false, true);
    });
  });
  els.candidateOverlay.classList.add("show");
}

export function hideCandidatePicker() {
  if (els.candidateOverlay) els.candidateOverlay.classList.remove("show");
}
