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

describe("Genius is the one sign-in CTA on the landing page (Yandex login removed)", () => {
  it("renders exactly one auth-btn, and it's the Genius sign-in", () => {
    expect(countOccurrences(html, 'class="auth-btn"')).toBe(1);
    expect(html).toContain('href="/auth/login"');
  });

  it("the auth-btn shows Genius, not Yandex, as the sign-in text", () => {
    const start = html.indexOf('class="auth-btn"');
    const end = html.indexOf("</a>", start);
    const button = html.slice(start, end);
    expect(button).toContain("Genius");
    expect(button).not.toMatch(/yandex/i);
  });

  it("has no leftover Yandex sign-in link anywhere on the page", () => {
    expect(html).not.toContain('href="/auth/yandex/login"');
    expect(html).not.toMatch(/or sign in (with|via) yandex/i);
  });
});

describe("game screens use the same unified sign-in CTA", () => {
  it("has exactly two gs-signin prompts (Cabinet, Season), both pointing at Genius login", () => {
    expect(countOccurrences(html, 'class="gs-signin"')).toBe(2);
    expect(countOccurrences(html, 'class="gs-signin" href="/auth/login"')).toBe(2);
  });

  it("game-screen sign-in prompts no longer mention Yandex", () => {
    const matches = [...html.matchAll(/gs-signin[\s\S]{0,80}/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m[0]).not.toMatch(/yandex/i);
    }
  });
});
