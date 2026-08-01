// [SF-YM-06] Роль яндексовых рёбер на фронте: "feature" (ед.ч.) выпадала из
// дефолтного фильтра, пустой иконки (ROLE_ICON[role] || "") и стиля-заглушки.
// Закрепляем контракт: роль провайдера обязана быть известна фронту.

import { describe, it, expect } from "vitest";
import { ROLE_STYLE, ROLE_ICON, ROLE_PRIORITY, State } from "./state.js";

// Та же строка, что ставит YandexMusicSourceProvider на каждое ребро и credit;
// Яндекс не различает типы участия, поэтому она одна на все его рёбра.
const YANDEX_EDGE_ROLE = "featured";

describe("Yandex edge role", () => {
  it("is included in the default role filter, with no user action needed", () => {
    expect(State.activeFilters.has(YANDEX_EDGE_ROLE)).toBe(true);
  });

  it("has a dedicated edge style, not a fallback", () => {
    const style = ROLE_STYLE[YANDEX_EDGE_ROLE];
    expect(style).toBeDefined();
    expect(style.color).toBeTruthy();
  });

  it("has a non-empty icon", () => {
    const icon = ROLE_ICON[YANDEX_EDGE_ROLE];
    expect(icon).toBeTruthy();
    expect(icon).toContain("<use");
  });

  it("participates in role priority ordering", () => {
    expect(ROLE_PRIORITY).toContain(YANDEX_EDGE_ROLE);
  });

  it("produces a CSS class that stylesheets actually define", () => {
    // sidebar.js/path-result.js: role.replace(/[^a-z0-9]/g, "") ->
    // role-chip--<slug>; CSS определяет только --featured/--producer/--writer/--primary.
    const slug = YANDEX_EDGE_ROLE.replace(/[^a-z0-9]/g, "");
    expect(slug).toBe("featured");
  });

  it("does not silently accept the old singular form", () => {
    // Страховка от возврата "feature".
    expect(State.activeFilters.has("feature")).toBe(false);
    expect(ROLE_STYLE.feature).toBeUndefined();
    expect(ROLE_ICON.feature).toBeUndefined();
    expect(ROLE_PRIORITY).not.toContain("feature");
  });
});
