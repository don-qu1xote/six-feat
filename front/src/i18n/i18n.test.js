import { describe, it, expect, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { t, setLang, initI18n, LANG_STORAGE_KEY } from "./i18n.js";
import { en, ru } from "./strings.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("lang");
  document.body.innerHTML = "";
  State.lang = "en";
});

describe("[SF-WEB-77] t() dictionary lookup", () => {
  it("answers in the active language, echoes an unknown key, and fills placeholders", () => {
    setLang("en");
    expect(t("settings.title")).toBe("Settings");

    setLang("ru");
    expect(t("settings.title")).toBe("Настройки");
    expect(t("__no_such_key__")).toBe("__no_such_key__");

    en["__test.greeting__"] = "Hello, {name}!";
    ru["__test.greeting__"] = "Привет, {name}!";
    try {
      expect(t("__test.greeting__", { name: "Ada" })).toBe("Привет, Ada!");
      setLang("en");
      expect(t("__test.greeting__", { name: "Ada" })).toBe("Hello, Ada!");
    } finally {
      delete en["__test.greeting__"];
      delete ru["__test.greeting__"];
    }
  });
});

describe("[SF-WEB-77] setLang() applies to the DOM", () => {
  it("translates text, attributes and placeholders, and stamps <html lang>", () => {
    document.body.innerHTML = `
      <span id="s" data-i18n="settings.title"></span>
      <div id="d" data-i18n-attr="title:hero.game.dailyEyebrowTitle"></div>
      <input id="i" data-i18n-placeholder="hero.search.placeholder" />`;

    setLang("ru");

    expect(document.documentElement.getAttribute("lang")).toBe("ru");
    expect(document.getElementById("s").textContent).toBe("Настройки");
    expect(document.getElementById("d").getAttribute("title")).toBe(
      ru["hero.game.dailyEyebrowTitle"],
    );
    expect(document.getElementById("i").getAttribute("placeholder")).toBe(
      ru["hero.search.placeholder"],
    );

    setLang("en");

    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.getElementById("d").getAttribute("title")).toBe(
      en["hero.game.dailyEyebrowTitle"],
    );
  });

  it("persists the choice unless asked not to, and knows only 'ru' and 'en'", () => {
    setLang("ru");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("ru");

    localStorage.clear();
    setLang("ru", { persist: false });
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBeNull();

    setLang("fr");
    expect(State.lang).toBe("en");
  });
});

describe("[SF-WEB-77] initI18n() startup detection", () => {
  it("restores a saved language, otherwise falls back to English", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "ru");
    initI18n();
    expect(State.lang).toBe("ru");

    localStorage.clear();
    State.lang = "en";
    initI18n();
    expect(State.lang).toBe("en");
  });
});
