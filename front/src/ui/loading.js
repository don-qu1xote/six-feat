import { els } from "../dom/dom.js";
import { t } from "../i18n/i18n.js";

const LOADING_PHRASE_KEYS = ["loading.artist1", "loading.artist2", "loading.artist3"];

export function showLoading(on, artist, message) {
  if (on) {
    const spinner = els.loading.querySelector(".spinner");
    const label = message
      ? message
      : artist
        ? t(LOADING_PHRASE_KEYS[Math.floor(Math.random() * LOADING_PHRASE_KEYS.length)], { artist })
        : t("loading.text");
    els.loading.innerHTML = "";
    if (spinner) els.loading.appendChild(spinner);
    els.loading.appendChild(document.createTextNode(" " + label));
  }
  els.loading.classList.toggle("show", !!on);
}
