// ════════════════════════════════════════════════════════════════════════════
// ui/loading.js — Loading indicator over the canvas while a search is in flight
// ════════════════════════════════════════════════════════════════════════════
import { els } from "../dom/dom.js";

const LOADING_PHRASES = [
  artist => `Charting ${artist}'s world…`,
  artist => `Mapping ${artist}'s collaborators…`,
  artist => `Tracing routes through ${artist}'s catalog…`
];

// [fix] `message` lets callers other than the artist search (path-finding —
// see ui/path-result.js) show their own contextual text on the SAME
// canvas-wide overlay, instead of hand-rolling a second loading mechanism
// embedded in their own panel. Was reported as "the path search process
// feels bolted into the window" — regular search never shows its loading
// state inside the hero search box either, it always uses this overlay.
export function showLoading(on, artist, message) {
  if (on) {
    const spinner = els.loading.querySelector(".spinner");
    const label = message
      ? message
      : artist
        ? LOADING_PHRASES[Math.floor(Math.random() * LOADING_PHRASES.length)](artist)
        : "Charting the network…";
    els.loading.innerHTML = "";
    if (spinner) els.loading.appendChild(spinner);
    els.loading.appendChild(document.createTextNode(" " + label));
  }
  els.loading.classList.toggle("show", !!on);
}
