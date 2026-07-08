// ════════════════════════════════════════════════════════════════════════════
// ui/loading.js — Loading indicator over the canvas while a search is in flight
// ════════════════════════════════════════════════════════════════════════════
import { els } from "../dom/dom.js";

const LOADING_PHRASES = [
  artist => `Charting ${artist}'s world…`,
  artist => `Mapping ${artist}'s collaborators…`,
  artist => `Tracing routes through ${artist}'s catalog…`
];

export function showLoading(on, artist) {
  if (on) {
    const spinner = els.loading.querySelector(".spinner");
    const label = artist
      ? LOADING_PHRASES[Math.floor(Math.random() * LOADING_PHRASES.length)](artist)
      : "Charting the network…";
    els.loading.innerHTML = "";
    if (spinner) els.loading.appendChild(spinner);
    els.loading.appendChild(document.createTextNode(" " + label));
  }
  els.loading.classList.toggle("show", !!on);
}
