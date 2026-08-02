import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf8",
);

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// [SF-WEB-73] Yandex is the single sign-in CTA everywhere the app links to a
// login endpoint — the landing hero and the two game-screen prompts
// (Cabinet, Season achievements). Genius login has no entry point left on
// any public screen; it only exists from Settings (SF-YM-05), which these
// tests don't touch since that panel is a separate, authenticated surface.
describe("[SF-WEB-73] Yandex is the one sign-in CTA on the landing page", () => {
  it("renders exactly one auth-btn, and it's the Yandex sign-in", () => {
    expect(countOccurrences(html, 'class="auth-btn"')).toBe(1);
    expect(html).toContain('href="/auth/yandex/login"');
  });

  it("the auth-btn shows Yandex, not Genius, as the sign-in text", () => {
    const start = html.indexOf('class="auth-btn"');
    const end = html.indexOf("</a>", start);
    const button = html.slice(start, end);
    expect(button).toContain("Yandex");
    expect(button).not.toMatch(/genius/i);
  });

  it("has no leftover Genius sign-in link anywhere on the page", () => {
    expect(html).not.toContain('href="/auth/login"');
    expect(html).not.toMatch(/or sign in (with|via) genius/i);
  });
});

describe("[SF-WEB-73] game screens use the same unified sign-in CTA", () => {
  it("has exactly two gs-signin prompts (Cabinet, Season), both pointing at Yandex login", () => {
    expect(countOccurrences(html, 'class="gs-signin"')).toBe(2);
    expect(countOccurrences(html, 'class="gs-signin" href="/auth/yandex/login"')).toBe(2);
  });

  it("game-screen sign-in prompts no longer mention Genius", () => {
    const matches = [...html.matchAll(/gs-signin[\s\S]{0,80}/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m[0]).not.toMatch(/genius/i);
    }
  });
});
