import { State } from "../state/state.js";
import { en, ru } from "./strings.js";

export const LANG_STORAGE_KEY = "six-feat-lang";

const dictionaries = { en, ru };

function normalizeLang(lang) {
  return lang === "ru" ? "ru" : "en";
}

export function t(key, vars) {
  const dict = dictionaries[State.lang] || dictionaries.en;
  let str = dict[key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      str = str.replaceAll(`{${name}}`, value);
    }
  }
  return str;
}

// [SF-WEB-79] Russian's 3-way plural (1 / 2-4 / 5+, with an 11-14 exception
// even for the "1" case) subsumes English's 2-way one, so a single rule
// picks the right key suffix for both languages instead of needing a
// separate English branch.
function pluralForm(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "few";
  return "many";
}

export function tPlural(baseKey, n) {
  return t(`${baseKey}.${pluralForm(n)}`, { n });
}

function applyToDom() {
  document.documentElement.setAttribute("lang", State.lang);

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });

  // data-i18n-attr="title:hero.game.dailyEyebrowTitle,aria-label:hero.mode.ariaLabel"
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const pair of el.getAttribute("data-i18n-attr").split(",")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });

  // data-i18n-placeholder is its own attribute (not data-i18n-attr) so a
  // single node can carry both a textContent key and a placeholder key
  // without the comma-joined data-i18n-attr format getting hard to read.
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });

  window.dispatchEvent(new CustomEvent("six-feat-langchange", { detail: { lang: State.lang } }));
}

function storedLang() {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    return saved === "en" || saved === "ru" ? saved : null;
  } catch {
    return null;
  }
}

export function setLang(lang, { persist = true } = {}) {
  State.lang = normalizeLang(lang);
  applyToDom();
  if (persist) {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, State.lang);
    } catch {
      // Private browsing / localStorage disabled — language still applies for this load.
    }
  }
}

export function initI18n() {
  const saved = storedLang();
  const detected = navigator.language && navigator.language.toLowerCase().startsWith("ru");
  setLang(saved || (detected ? "ru" : "en"), { persist: false });
}
