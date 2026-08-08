import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State } from "../state/state.js";
import { buildNodeTooltip, buildEdgeTooltip } from "./tooltips.js";

const node = (over = {}) => ({ id: 1, name: "Drake", isSeed: false, totalWeight: 0, ...over });

beforeEach(() => {
  State.expandedNodes = new Set();
  State.game = { mode: false };
  State.lang = "en";
});

describe("buildNodeTooltip", () => {
  it("leads with the artist name", () => {
    const el = buildNodeTooltip(node({ name: "Drake" }));
    expect(el.querySelector(".tt-name").textContent).toContain("Drake");
  });

  it("badges the seed artist and nobody else", () => {
    expect(buildNodeTooltip(node({ isSeed: true })).querySelector(".tt-seed")).not.toBeNull();
    expect(buildNodeTooltip(node({ isSeed: false })).querySelector(".tt-seed")).toBeNull();
  });

  it("shows a collaboration count only when there is one", () => {
    expect(buildNodeTooltip(node({ totalWeight: 12 })).querySelector(".tt-meta")).not.toBeNull();
    expect(buildNodeTooltip(node({ totalWeight: 0 })).querySelector(".tt-meta")).toBeNull();
  });

  it("marks a node the user already expanded", () => {
    State.expandedNodes = new Set([1]);
    expect(buildNodeTooltip(node({ id: 1 })).textContent.toLowerCase()).toContain("expanded");
  });

  it("hides the expanded marker in game mode, where expanding is not the point", () => {
    State.expandedNodes = new Set([1]);
    State.game = { mode: true };

    expect(buildNodeTooltip(node({ id: 1 })).textContent.toLowerCase()).not.toContain("expanded");
  });

  it("gives game mode its own hint text", () => {
    const explorer = buildNodeTooltip(node()).querySelector(".tt-hint").textContent;
    State.game = { mode: true };
    const game = buildNodeTooltip(node()).querySelector(".tt-hint").textContent;

    expect(game).not.toBe(explorer);
    expect(game).toBeTruthy();
  });

  it("works when there is no game state at all", () => {
    State.game = undefined;
    expect(() => buildNodeTooltip(node())).not.toThrow();
  });

  it("escapes markup in the artist name", () => {
    const el = buildNodeTooltip(node({ name: "<img src=x onerror=boom>" }));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".tt-name").textContent).toContain("<img src=x onerror=boom>");
  });
});

describe("buildEdgeTooltip", () => {
  const names = { 1: "Drake", 2: "Future" };
  const edge = (over = {}) => ({ from: 1, to: 2, weight: 3, dominantRole: "featured", ...over });

  it("names both ends of the edge", () => {
    const el = buildEdgeTooltip(edge(), names);
    const shown = [...el.querySelectorAll(".tt-head .tt-name")].map((n) => n.textContent);
    expect(shown).toEqual(["Drake", "Future"]);
  });

  it("falls back to a placeholder for an artist missing from the name map", () => {
    const el = buildEdgeTooltip(edge({ from: 99 }), names);
    expect(el.querySelector(".tt-head").textContent).toContain("?");
  });

  it("lists each shared track", () => {
    const el = buildEdgeTooltip(
      edge({
        collaborations: [
          { song: "Way 2 Sexy", roles: ["featured"] },
          { song: "Life Is Good", roles: ["featured", "writer"] },
        ],
      }),
      names,
    );

    const songs = [...el.querySelectorAll(".tt-song")].map((n) => n.textContent);
    expect(songs).toEqual(["Way 2 Sexy", "Life Is Good"]);
  });

  it("renders one role pill per credited role on a track", () => {
    const el = buildEdgeTooltip(
      edge({ collaborations: [{ song: "Life Is Good", roles: ["featured", "writer"] }] }),
      names,
    );
    expect(el.querySelectorAll(".tt-role")).toHaveLength(2);
  });

  it("names an untitled track rather than leaving the row blank", () => {
    const el = buildEdgeTooltip(edge({ collaborations: [{ roles: ["featured"] }] }), names);
    expect(el.querySelector(".tt-song").textContent.trim()).not.toBe("");
  });

  it("says so explicitly when no track list came back", () => {
    expect(buildEdgeTooltip(edge(), names).querySelector(".tt-empty")).not.toBeNull();
  });

  it("treats a malformed collaborations payload as no tracks, not a crash", () => {
    const el = buildEdgeTooltip(edge({ collaborations: "nope" }), names);
    expect(el.querySelector(".tt-empty")).not.toBeNull();
  });

  it("tolerates a track whose roles field is not a list", () => {
    const el = buildEdgeTooltip(edge({ collaborations: [{ song: "X", roles: null }] }), names);
    expect(el.querySelector(".tt-song").textContent).toBe("X");
    expect(el.querySelectorAll(".tt-role")).toHaveLength(0);
  });

  it("slugifies a role so it can only ever produce a safe class name", () => {
    const el = buildEdgeTooltip(
      edge({ collaborations: [{ song: "X", roles: ["Co-Producer!"] }] }),
      names,
    );
    const pill = el.querySelector(".tt-role");
    expect(pill.className).toBe("tt-role tt-role--coproducer");
    expect(pill.getAttribute("title")).toBe("Co-Producer!");
  });

  it("defaults an edge with no dominant role to primary", () => {
    const el = buildEdgeTooltip(edge({ dominantRole: undefined }), names);
    expect(el.querySelector(".tt-role-badge").getAttribute("title")).toBe("primary");
  });

  it("counts a missing or zero weight as one shared track", () => {
    for (const weight of [undefined, 0, -2]) {
      const el = buildEdgeTooltip(edge({ weight }), names);
      expect(el.querySelector(".tt-meta").textContent).toMatch(/\b1\b/);
    }
  });

  it("escapes markup in track titles", () => {
    const el = buildEdgeTooltip(edge({ collaborations: [{ song: "<b>x</b>", roles: [] }] }), names);
    expect(el.querySelector(".tt-song b")).toBeNull();
  });
});

describe("ensureTooltipCollisionGuard", () => {
  let observed;

  // Факт «наблюдатель уже привешен» живёт в переменной уровня модуля, поэтому
  // каждый тест здесь берёт свежий импорт — иначе первый же вызов навсегда
  // закрывает путь для остальных.
  async function freshGuard({ withNetwork = true } = {}) {
    vi.resetModules();
    observed = [];
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe(target, options) {
          observed.push({ target, options });
        }
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (cb) => cb());
    document.body.innerHTML = `<div id="network"></div>`;

    const { els: freshEls } = await import("../dom/dom.js");
    freshEls.network = withNetwork ? document.getElementById("network") : null;
    const fresh = await import("./tooltips.js");
    return { run: fresh.ensureTooltipCollisionGuard, network: freshEls.network };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("watches the canvas for tooltips being added or restyled", async () => {
    const { run, network } = await freshGuard();
    run();

    expect(observed).toHaveLength(1);
    expect(observed[0].target).toBe(network);
    expect(observed[0].options).toMatchObject({ childList: true, subtree: true });
    expect(observed[0].options.attributeFilter).toEqual(["style"]);
  });

  it("attaches only once, however many networks are built", async () => {
    const { run } = await freshGuard();
    run();
    run();

    expect(observed).toHaveLength(1);
  });

  it("does nothing when there is no canvas to watch", async () => {
    const { run } = await freshGuard({ withNetwork: false });

    expect(() => run()).not.toThrow();
    expect(observed).toHaveLength(0);
  });

  it("still attaches later, once the canvas exists", async () => {
    const { run } = await freshGuard({ withNetwork: false });
    run();
    expect(observed).toHaveLength(0);

    const { els: freshEls } = await import("../dom/dom.js");
    freshEls.network = document.getElementById("network");
    run();

    expect(observed).toHaveLength(1);
  });
});

describe("tooltip collision repositioning", () => {
  let fire;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("requestAnimationFrame", (cb) => cb());
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(cb) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    document.body.innerHTML = `<div id="network"></div>`;
    const { els: freshEls } = await import("../dom/dom.js");
    freshEls.network = document.getElementById("network");
    const fresh = await import("./tooltips.js");
    fresh.ensureTooltipCollisionGuard();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function tooltipAt({ left, top, width = 100, height = 50 }) {
    const el = document.createElement("div");
    el.className = "vis-tooltip";
    document.getElementById("network").appendChild(el);
    el.getBoundingClientRect = () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    });
    return el;
  }

  it("leaves a tooltip alone when it already fits on screen", () => {
    const el = tooltipAt({ left: 100, top: 100 });
    fire([{ type: "childList", addedNodes: [el], target: document.body }]);

    expect(el.style.transform).toBe("");
  });

  it("pulls a tooltip back inside the right edge", () => {
    const el = tooltipAt({ left: window.innerWidth - 20, top: 100 });
    fire([{ type: "childList", addedNodes: [el], target: document.body }]);

    expect(el.style.transform).toMatch(/translate\(-\d+px, 0px\)/);
  });

  it("pushes a tooltip down when it pokes off the top", () => {
    const el = tooltipAt({ left: 100, top: -30 });
    fire([{ type: "childList", addedNodes: [el], target: document.body }]);

    expect(el.style.transform).toMatch(/translate\(0px, \d+px\)/);
  });

  it("lifts a tooltip that hangs below the bottom edge", () => {
    const el = tooltipAt({ left: 100, top: window.innerHeight - 10 });
    fire([{ type: "childList", addedNodes: [el], target: document.body }]);

    expect(el.style.transform).toMatch(/translate\(0px, -\d+px\)/);
  });

  it("ignores non-element nodes and non-tooltip elements", () => {
    const text = document.createTextNode("hi");
    const other = document.createElement("div");
    expect(() =>
      fire([{ type: "childList", addedNodes: [text, other], target: document.body }]),
    ).not.toThrow();
  });

  it("does not fight its own style write when the tooltip is restyled", () => {
    const el = tooltipAt({ left: window.innerWidth - 20, top: 100 });
    fire([{ type: "childList", addedNodes: [el], target: el }]);
    const applied = el.style.transform;

    // Повторное событие про тот же самый transform не должно ничего пересчитывать.
    el.getBoundingClientRect = () => {
      throw new Error("не должно вызываться");
    };
    expect(() =>
      fire([{ type: "attributes", attributeName: "style", addedNodes: [], target: el }]),
    ).not.toThrow();
    expect(el.style.transform).toBe(applied);
  });

  it("skips a tooltip that has already been detached", () => {
    const el = tooltipAt({ left: 100, top: 100 });
    el.remove();

    expect(() =>
      fire([{ type: "childList", addedNodes: [el], target: document.body }]),
    ).not.toThrow();
  });
});
