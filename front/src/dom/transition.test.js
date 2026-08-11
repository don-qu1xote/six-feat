import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { els } from "./dom.js";
import { runHeroGraphTransition } from "./transition.js";

function renderMarkup() {
  document.body.innerHTML = `
    <div id="search-modal"><div class="search-wrap">search</div></div>
    <button id="btn-search-open">open</button>`;
  els.searchModal = document.getElementById("search-modal");
}

function rect(over = {}) {
  return () => ({ left: 0, top: 0, width: 100, height: 40, ...over });
}

function stubReducedMotion(matches) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches }));
}

let rafCallbacks;
let originalAnimate;

beforeEach(() => {
  renderMarkup();
  stubReducedMotion(false);
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  originalAnimate = Element.prototype.animate;
  delete document.startViewTransition;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Element.prototype.animate = originalAnimate;
  delete document.startViewTransition;
});

const flushRaf = () => rafCallbacks.splice(0).forEach((cb) => cb());

describe("runHeroGraphTransition — prefers-reduced-motion", () => {
  it("runs the mutation synchronously and skips any transition mechanism entirely", () => {
    stubReducedMotion(true);
    const mutate = vi.fn();

    runHeroGraphTransition(mutate, "toGraph");

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(rafCallbacks).toHaveLength(0);
    expect(els.searchModal.classList.contains("is-morphing")).toBe(false);
  });

  it("does not consult View Transitions at all under reduced motion", () => {
    stubReducedMotion(true);
    const startViewTransition = vi.fn();
    document.startViewTransition = startViewTransition;

    runHeroGraphTransition(vi.fn(), "toGraph");

    expect(startViewTransition).not.toHaveBeenCalled();
  });
});

describe("native View Transitions path", () => {
  it("hands the mutation to the browser and marks the modal while it runs", async () => {
    let finish;
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    const startViewTransition = vi.fn((cb) => {
      cb();
      return { finished };
    });
    document.startViewTransition = startViewTransition;

    const mutate = vi.fn();
    runHeroGraphTransition(mutate, "toGraph");

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(els.searchModal.classList.contains("is-morphing")).toBe(true);

    expect(rafCallbacks).toHaveLength(0);

    finish();
    await finished;
    await Promise.resolve();

    expect(els.searchModal.classList.contains("is-morphing")).toBe(false);
  });
});

describe("FLIP fallback", () => {
  it("mutates immediately and animates a ghost of the search box", () => {
    const searchWrap = document.querySelector(".search-wrap");
    const target = document.getElementById("btn-search-open");
    searchWrap.getBoundingClientRect = rect({ left: 10, top: 20, width: 200, height: 60 });
    target.getBoundingClientRect = rect({ left: 300, top: 400, width: 40, height: 40 });

    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    Element.prototype.animate = animate;

    const mutate = vi.fn();
    runHeroGraphTransition(mutate, "toGraph");

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(els.searchModal.classList.contains("is-morphing")).toBe(true);

    flushRaf();

    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes, options] = animate.mock.calls[0];
    expect(keyframes[0].opacity).toBe(1);
    expect(keyframes[1].opacity).toBe(0);
    expect(options.fill).toBe("forwards");
  });

  it("positions the ghost over the original box before moving it", () => {
    const searchWrap = document.querySelector(".search-wrap");
    searchWrap.getBoundingClientRect = rect({ left: 10, top: 20, width: 200, height: 60 });
    document.getElementById("btn-search-open").getBoundingClientRect = rect();

    let ghost;
    Element.prototype.animate = function () {
      ghost = this;
      return { finished: Promise.resolve() };
    };

    runHeroGraphTransition(vi.fn(), "toGraph");
    flushRaf();

    expect(ghost.classList.contains("flip-ghost")).toBe(true);
    expect(ghost.style.left).toBe("10px");
    expect(ghost.style.top).toBe("20px");
    expect(ghost.style.width).toBe("200px");
    expect(ghost.style.height).toBe("60px");
  });

  it("hides the real search box while the ghost flies, then restores it", async () => {
    const searchWrap = document.querySelector(".search-wrap");
    searchWrap.getBoundingClientRect = rect();
    document.getElementById("btn-search-open").getBoundingClientRect = rect();

    let ghost;
    const finished = Promise.resolve();
    Element.prototype.animate = function () {
      ghost = this;
      return { finished };
    };

    runHeroGraphTransition(vi.fn(), "toGraph");
    flushRaf();

    expect(searchWrap.style.visibility).toBe("hidden");
    expect(document.body.contains(ghost)).toBe(true);

    await finished;
    await Promise.resolve();

    expect(searchWrap.style.visibility).toBe("");
    expect(document.body.contains(ghost)).toBe(false);
    expect(els.searchModal.classList.contains("is-morphing")).toBe(false);
  });

  it("never scales the ghost below a floor, so it stays visible mid-flight", () => {
    const searchWrap = document.querySelector(".search-wrap");
    searchWrap.getBoundingClientRect = rect({ width: 1000, height: 1000 });
    document.getElementById("btn-search-open").getBoundingClientRect = rect({
      width: 1,
      height: 1,
    });

    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    Element.prototype.animate = animate;

    runHeroGraphTransition(vi.fn(), "toGraph");
    flushRaf();

    expect(animate.mock.calls[0][0][1].transform).toContain("scale(0.35, 0.35)");
  });

  it("still applies the change when there is nothing to animate from", () => {
    document.body.innerHTML = `<div id="search-modal"></div>`;
    els.searchModal = document.getElementById("search-modal");

    const mutate = vi.fn();
    runHeroGraphTransition(mutate, "toGraph");

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(rafCallbacks).toHaveLength(0);
    expect(els.searchModal.classList.contains("is-morphing")).toBe(false);
  });

  it("still applies the change when the morph target is absent", () => {
    document.getElementById("btn-search-open").remove();

    const mutate = vi.fn();
    runHeroGraphTransition(mutate, "toGraph");

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(rafCallbacks).toHaveLength(0);
  });
});
