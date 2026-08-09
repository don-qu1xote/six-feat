// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function bundleCss() {
  const result = buildSync({
    entryPoints: [join(here, "index.css")],
    bundle: true,
    write: false,
  });
  return result.outputFiles[0].text;
}

const css = bundleCss();

describe("SF-WEB-40 design-system CSS bundle", () => {
  it("bundles a non-empty stylesheet from src/styles/index.css", () => {
    expect(css.length).toBeGreaterThan(10000);
  });

  it("drives both themes from tokens (dark :root + light override), not hardcoded", () => {
    expect(css).toContain(":root");
    expect(css).toMatch(/\[data-theme=("?)light\1\]/);

    for (const token of ["--signal", "--pulse", "--paper", "--ink", "--mist"]) {
      expect(css, `token ${token} missing`).toContain(token);
    }
  });

  it("keeps every JS-hook selector the app renders against", () => {
    const hooks = [
      // canvas / graph
      "#network",
      ".app-canvas",
      ".canvas-decorator",
      ".ui-state-slot",
      // search / hero
      ".search-modal",
      ".search-wrap",
      ".hero-mode-switch",
      ".ac-dropdown",
      ".chip",
      ".include-roles-row",
      // rail / controls / status
      ".rail",
      ".rail-btn",
      ".settings-toggle",
      ".seed-card",
      ".canvas-zoom-cluster",
      ".role-filter-segment",
      ".rate-limit-badge",
      ".scan-status-badge",
      ".help-overlay",
      ".context-panel",
      // companion panel + sections
      ".companion-panel",
      ".artist-sidebar",
      ".sidebar-body",
      ".path-panel",
      ".compare-panel",
      ".hop-chain",
      ".path-chain-track",
      ".role-chip--featured",
      // overlays
      ".candidate-overlay",
      ".node-search-overlay",
      ".overlay",
      ".spinner",
      ".toast",
      ".vis-tooltip",
      // component kit
      ".ui-btn",
      ".ui-chip",
      ".ui-pill",
      ".ui-segment",
      ".ui-panel",
      ".ui-tile",
      ".bento-tile",
    ];
    for (const hook of hooks) {
      expect(css, `hook selector ${hook} missing from bundle`).toContain(hook);
    }
  });

  it("keeps the state/behaviour class hooks JS toggles", () => {
    // Modifier classes added/removed by JS at runtime — their rules must survive.
    for (const cls of [
      ".search-modal.docked",
      ".search-modal.is-closed",
      ".companion-panel.show",
      ".artist-sidebar.show",
      ".path-panel.show",
      ".compare-panel.show",
      ".app-canvas.search-open",
      ".hero-mode-panel.is-active",
    ]) {
      expect(css, `state hook ${cls} missing`).toContain(cls);
    }
  });

  // [fix] companion.css's "1 hop from seed" / path-chain / compare-item
  // cards hardcoded rgba(20,26,40,...)/(40,48,68,...)/(94,230,197,...)/
  // (185,138,255,...) — the dark theme's own hex, pinned regardless of
  // which theme was active — instead of the theme-aware --panel-rgb/
  // --line-rgb/--signal-rgb/--pulse-rgb triplets .path-input right next to
  // them already used. Result: those cards stayed dark-styled under
  // :root[data-theme="light"]. Guards against the literals creeping back
  // (checks the raw source, not the bundle — tokens.css/button.css's own
  // prose comments mention these exact numbers when explaining past fixes,
  // which would false-positive a bundle-wide check).
  it("companion.css's path/compare cards use RGB-triplet tokens, not dark-pinned literals", () => {
    const companionSrc = readFileSync(join(here, "surfaces/companion.css"), "utf8");
    for (const literal of [
      /rgba\(\s*20,\s*26,\s*40/,
      /rgba\(\s*40,\s*48,\s*68/,
      /rgba\(\s*94,\s*230,\s*197/,
      /rgba\(\s*185,\s*138,\s*255/,
    ]) {
      expect(companionSrc, `dark-pinned literal ${literal} still present`).not.toMatch(literal);
    }
  });

  it("defines a theme-aware --line-rgb triplet, redefined per theme", () => {
    expect(css).toContain("--line-rgb");
  });

  // [fix] --on-accent (text on the signal→pulse accent gradient — the
  // primary button, hero-mode thumb, etc.) used to be a single fixed
  // near-black value shared by both themes. Light theme's --signal/--pulse
  it("light theme overrides --on-accent instead of inheriting the dark near-black default", () => {
    const lightBlockRaw =
      rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");
    expect(lightBlockRaw, "light theme :root block not found").toBeTruthy();
    expect(lightBlockRaw).toMatch(/--on-accent:\s*#[0-9a-fA-F]{6}/);
    const rootBlock = rule(css, ":root");
    const darkOnAccent = rootBlock.match(/--on-accent:\s*(#[0-9a-fA-F]{6})/)[1];
    const lightOnAccent = lightBlockRaw.match(/--on-accent:\s*(#[0-9a-fA-F]{6})/)[1];
    expect(lightOnAccent.toLowerCase()).not.toBe(darkOnAccent.toLowerCase());
  });

  it(".path-result is gone — path search loading/errors go through #loading/#toast, not an embedded element", () => {
    expect(css).not.toMatch(/(?:^|\n)\.path-result\s*[.{]/);
    expect(css).not.toContain(".hero-connect-panel .path-result");
  });

  it(".path-panel/.compare-panel use min(Xvh, 100%), not a bare percentage max-height", () => {
    for (const selector of [".path-panel", ".compare-panel"]) {
      const block = rule(css, selector);
      expect(block, `${selector} rule missing`).toBeTruthy();
      expect(block, `${selector} still has a bare percentage max-height`).not.toMatch(
        /max-height:\s*\d+%/,
      );
      expect(block).toMatch(/max-height:\s*min\(\d+vh,\s*100%\)/);
    }
  });

  it(".path-swap-btn exists and is a real (non-decorative) circular icon control", () => {
    const block = rule(css, ".path-swap-btn");
    expect(block, ".path-swap-btn rule missing").toBeTruthy();
    expect(block).toMatch(/border-radius:\s*50%/);
  });

  it(".dock-btn--primary distinguishes the submit action with a signal border, not a fill", () => {
    const block = rule(css, ".dock-btn--primary");
    expect(block, ".dock-btn--primary rule missing").toBeTruthy();
    expect(block).toMatch(/border-color:\s*rgba\(var\(--signal-rgb\)/);
    expect(block).not.toMatch(/background:\s*linear-gradient/);
  });

  it(".path-clear-btn is a plain text link, not a second bordered pill matching Find path", () => {
    const block = rule(css, ".path-clear-btn");
    expect(block, ".path-clear-btn rule missing").toBeTruthy();
    expect(block).toMatch(/border:\s*0/);
    expect(block).toMatch(/background:\s*transparent/);
  });
});

describe("SF-WEB-47 motion tokens", () => {
  it("defines every duration/ease/stagger token the motion system relies on", () => {
    for (const token of [
      "--ease-standard",
      "--ease-out",
      "--ease-emphasized",
      "--duration-fast",
      "--duration-base",
      "--duration-med",
      "--duration-slow",
      "--duration-slower",
      "--duration-xslow",
      "--duration-flight",
      "--duration-camera",
      "--duration-xxslow",
      "--duration-loop",
      "--stagger-1",
      "--stagger-2",
      "--stagger-3",
    ]) {
      expect(css, `token ${token} missing`).toContain(token);
    }
  });
});

function extractVar(block, name) {
  const m = block && block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1] : null;
}

function relLuminance(hex) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(hexA, hexB) {
  const lA = relLuminance(hexA),
    lB = relLuminance(hexB);
  const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_TEXT = 4.5;
describe("[SF-WEB-49] theme tokens — dark + light both defined, not one inverted from the other", () => {
  const darkBlock = rule(css, ":root");
  const lightBlock = rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");

  it("both theme blocks exist in the bundle", () => {
    expect(darkBlock, ":root block missing").toBeTruthy();
    expect(lightBlock, ':root[data-theme="light"] block missing').toBeTruthy();
  });

  it("every color token the app themes redefines a real, distinct value in light — not inherited from dark", () => {
    const colorTokens = [
      "--ink",
      "--ink-2",
      "--panel",
      "--panel-2",
      "--line",
      "--mist",
      "--paper",
      "--signal",
      "--pulse",
      "--amber",
      "--warn",
      "--neon",
      "--primary2",
      "--on-accent",
      "--hero-glow",
      "--panel-rgb",
      "--ink2-rgb",
      "--line-rgb",
      "--panel-2-rgb",
      "--signal-rgb",
      "--pulse-rgb",
      "--amber-rgb",
      "--primary2-rgb",
    ];
    for (const token of colorTokens) {
      const inLight = lightBlock.match(new RegExp(`${token}:\\s*[^;]+;`));
      expect(inLight, `${token} not redefined in the light theme block`).toBeTruthy();
    }
  });
});

describe("[SF-WEB-49] theme contrast — text-bearing accents clear AA (4.5:1) in both themes", () => {
  const darkBlock = rule(css, ":root");
  const lightBlock = rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");

  function themeVars(block) {
    const v = (name) => extractVar(block, name);
    return {
      panel: v("--panel"),
      ink: v("--ink"),
      paper: v("--paper"),
      mist: v("--mist"),
      signal: v("--signal"),
      pulse: v("--pulse"),
      amber: v("--amber"),
      onAccent: v("--on-accent"),
    };
  }

  it("dark theme", () => {
    const t = themeVars(darkBlock);
    expect(contrastRatio(t.paper, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.amber, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.pulse, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.onAccent, t.signal)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.onAccent, t.pulse)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("light theme — same thresholds as dark, not a looser bar for the 'inverted' palette", () => {
    const t = themeVars(lightBlock);
    expect(contrastRatio(t.paper, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.amber, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.pulse, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.pulse, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.onAccent, t.signal)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.onAccent, t.pulse)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("[SF-WEB-50] landing decorator — reduced-motion stops the drift", () => {
  it(".decor-dot animates by default", () => {
    const block = rule(css, ".decor-dot");
    expect(block, ".decor-dot rule missing").toBeTruthy();
    expect(block).toMatch(/animation:\s*decor-drift/);
  });

  it("prefers-reduced-motion turns .decor-dot's animation off", () => {
    const mq = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(mq, "no prefers-reduced-motion: reduce block found").toBeGreaterThan(-1);
    const mqBlock = css.slice(mq, mq + 300);
    expect(mqBlock).toMatch(/\.decor-dot\s*\{[^}]*animation:\s*none/);
  });

  it("the dandelion's own nodes/edges never declare an animation to begin with — nothing to gate", () => {
    for (const selector of [".decor-node", ".decor-edge"]) {
      const block = rule(css, selector);
      expect(block, `${selector} rule missing`).toBeTruthy();
      expect(block).not.toMatch(/animation:/);
    }
  });
});

describe("[SF-GAME-54] display:flex не должен перебивать атрибут hidden", () => {
  const guarded = [
    ".hero-game-daily",
    ".hero-game-rivals",
    ".hero-game-divider",
    ".connect-endpoints",
    ".clp-progress",
  ];

  for (const sel of guarded) {
    it(`${sel} гасится своим [hidden]-правилом`, () => {
      const base = rule(css, sel);
      expect(base, `${sel}: правила нет вовсе`).toBeTruthy();
      if (!/display:\s*(flex|grid|block|inline-flex)/.test(base)) return;
      const re = new RegExp(`\\${sel}\\[hidden\\][^{]*\\{[^}]*display:\\s*none`);
      expect(re.test(css), `${sel}: display объявлен, а [hidden]-guard'а нет`).toBe(true);
    });
  }
});

describe("[SF-GAME-59] панель игры на главной стоит на общих деталях", () => {
  const bespoke = [".hero-game-duel", ".duel-side", ".duel-input", ".duel-vs", ".hero-game-start"];

  for (const sel of bespoke) {
    it(`${sel} — своего правила больше нет`, () => {
      expect(rule(css, sel), `${sel}: свой набор вернулся`).toBeNull();
    });
  }

  it("общий контейнер hero-панели покрывает и Connect, и Game", () => {
    const idx = css.indexOf(".hero-game-panel");
    expect(idx, ".hero-game-panel не участвует ни в одном правиле").toBeGreaterThan(-1);
    expect(css).toMatch(/\.hero-connect-panel,\s*\n?\s*\.hero-game-panel\s*\{[^}]*width:\s*100%/);
  });
});

function rule(css, selector) {
  const idx = css.indexOf(`${selector} {`);
  if (idx === -1) return null;
  const end = css.indexOf("}", idx);
  return css.slice(idx, end + 1);
}

// [E2E settings-reachable] Кнопка настроек обязана открываться с любого
// экрана. Она уже несла z-index: var(--z-docked) (30), но лежала внутри
// .canvas-chrome с z-index: var(--z-panel) (20) — тот создаёт контекст
// наложения, внутри которого 30 ничего не значит снаружи. Игровые экраны —
// такие же 20, но ниже по документу, — накрывали кнопку и перехватывали
// клики на всех пяти игровых поверхностях. Проверяем оба инварианта здесь,
// а не только в E2E: тест стоит миллисекунды, E2E-прогон — минуты.
describe("настройки достижимы с игровых экранов", () => {
  const html = readFileSync(join(here, "..", "..", "index.html"), "utf8");

  function ancestorsOf(marker) {
    const upto = html.slice(0, html.indexOf(marker));
    const stack = [];
    for (const m of upto.matchAll(/<(\/?)(section|div|main|nav|aside)\b[^>]*>/g)) {
      if (m[1]) stack.pop();
      else if (!m[0].trimEnd().endsWith("/>")) stack.push(m[0]);
    }
    return stack;
  }

  it("кнопка настроек не лежит внутри .canvas-chrome", () => {
    const enclosing = ancestorsOf('id="btn-settings-open"').join(" ");
    expect(enclosing).not.toContain("canvas-chrome");
  });

  it("кнопка позиционируется от вьюпорта, а не от исчезнувшего родителя", () => {
    const rule = css.slice(css.indexOf(".settings-toggle {"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("position: fixed");
  });

  it("её слой выше игровых экранов", () => {
    const toggle = css.slice(css.indexOf(".settings-toggle {"));
    expect(toggle.slice(0, toggle.indexOf("}"))).toContain("--z-docked");

    const screen = css.slice(css.indexOf(".game-screen {"));
    expect(screen.slice(0, screen.indexOf("}"))).toContain("--z-surface");
  });
});
