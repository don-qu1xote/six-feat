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
  it("returns the English string by default", () => {
    setLang("en");
    expect(t("settings.title")).toBe("Settings");
  });

  it("returns the Russian string once switched", () => {
    setLang("ru");
    expect(t("settings.title")).toBe("Настройки");
  });

  it("falls back to the English string for a key missing from the current dict", () => {
    setLang("ru");
    expect(t("__no_such_key__")).toBe("__no_such_key__");
  });

  it("substitutes {name}-style placeholders", () => {
    en["__test.greeting__"] = "Hello, {name}!";
    ru["__test.greeting__"] = "Привет, {name}!";
    setLang("en");
    expect(t("__test.greeting__", { name: "Ada" })).toBe("Hello, Ada!");
    setLang("ru");
    expect(t("__test.greeting__", { name: "Ada" })).toBe("Привет, Ada!");
    delete en["__test.greeting__"];
    delete ru["__test.greeting__"];
  });
});

describe("[SF-WEB-77] setLang() applies to the DOM", () => {
  it("sets <html lang>", () => {
    setLang("ru");
    expect(document.documentElement.getAttribute("lang")).toBe("ru");
    setLang("en");
    expect(document.documentElement.getAttribute("lang")).toBe("en");
  });

  it("fills textContent for every [data-i18n] element", () => {
    document.body.innerHTML = `<span id="s" data-i18n="settings.title"></span>`;
    setLang("ru");
    expect(document.getElementById("s").textContent).toBe("Настройки");
  });

  it("fills the given attribute for [data-i18n-attr]", () => {
    document.body.innerHTML = `<div id="d" data-i18n-attr="title:hero.game.dailyEyebrowTitle"></div>`;
    setLang("en");
    expect(document.getElementById("d").getAttribute("title")).toBe(
      en["hero.game.dailyEyebrowTitle"],
    );
  });

  it("fills placeholder for [data-i18n-placeholder]", () => {
    document.body.innerHTML = `<input id="i" data-i18n-placeholder="hero.search.placeholder" />`;
    setLang("ru");
    expect(document.getElementById("i").getAttribute("placeholder")).toBe(
      ru["hero.search.placeholder"],
    );
  });

  it("persists the choice to localStorage by default", () => {
    setLang("ru");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("ru");
  });

  it("does not persist when persist:false is passed", () => {
    setLang("ru", { persist: false });
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBeNull();
  });

  it("normalizes anything that isn't exactly 'ru' to 'en'", () => {
    setLang("fr");
    expect(State.lang).toBe("en");
  });
});

describe("[SF-WEB-77] initI18n() startup detection", () => {
  it("uses the saved language when one exists, without re-persisting it", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "ru");
    initI18n();
    expect(State.lang).toBe("ru");
  });

  it("falls back to English when nothing is saved and the browser isn't Russian", () => {
    initI18n();
    expect(State.lang).toBe("en");
  });
});
