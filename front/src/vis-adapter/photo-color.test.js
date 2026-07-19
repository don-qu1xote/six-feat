// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/photo-color.test.js — [SF-WEB-58 B] dominant-color sampling.
// jsdom has no real <canvas> 2D backend (HTMLCanvasElement.getContext
// returns null without the optional "canvas" npm package), so the pixel-
// averaging path is exercised end-to-end by stubbing
// HTMLCanvasElement.prototype.getContext with a controllable fake context
// (drawImage/getImageData) — same "record/replay" spirit as edge-render.
// test.js's mockCtx, applied to the sampling side instead of the draw side.
// The Image-loading orchestration itself mirrors canvas-controls.test.js's
// waitForImages tests: replace globalThis.Image, fire onload manually.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { State } from "../state/state.js";
import { ensureNodeColorSampled, getCachedDominantColor, clearDominantColorCache } from "./photo-color.js";

// Solid-fill fake 2D context: getImageData always returns SAMPLE_SIZE² pixels
// of the given RGBA, regardless of what drawImage was "given" — enough to
// drive the averaging loop deterministically without a real image decoder.
function fakeCtx(r, g, b, a = 255) {
  return {
    drawImage() {},
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
      }
      return { data };
    },
  };
}

let realImage, realGetContext;

beforeEach(() => {
  clearDominantColorCache();
  State.network = null;
  realImage = globalThis.Image;
  realGetContext = HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  globalThis.Image = realImage;
  HTMLCanvasElement.prototype.getContext = realGetContext;
  vi.unstubAllGlobals();
});

function mockLoadableImage() {
  const images = [];
  globalThis.Image = class {
    constructor() { images.push(this); }
  };
  return images;
}

describe("ensureNodeColorSampled / getCachedDominantColor", () => {
  it("caches the averaged color once a mock photo finishes loading", () => {
    const images = mockLoadableImage();
    HTMLCanvasElement.prototype.getContext = () => fakeCtx(200, 50, 10);

    expect(getCachedDominantColor(1)).toBeNull();
    ensureNodeColorSampled(1, "https://images.genius.com/photo.jpg");
    expect(getCachedDominantColor(1)).toBeNull();  // still loading

    images[0].onload();
    expect(getCachedDominantColor(1)).toBe("#c8320a");  // 200,50,10 in hex
  });

  it("triggers network.redraw() once a color becomes available, so a repaint picks it up", () => {
    const images = mockLoadableImage();
    HTMLCanvasElement.prototype.getContext = () => fakeCtx(10, 20, 30);
    const redraw = vi.fn();
    State.network = { redraw };

    ensureNodeColorSampled(1, "https://images.genius.com/photo.jpg");
    expect(redraw).not.toHaveBeenCalled();
    images[0].onload();
    expect(redraw).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second call for an already-pending or already-cached node doesn't load a second image", () => {
    const images = mockLoadableImage();
    HTMLCanvasElement.prototype.getContext = () => fakeCtx(1, 2, 3);

    ensureNodeColorSampled(1, "https://images.genius.com/a.jpg");
    ensureNodeColorSampled(1, "https://images.genius.com/a.jpg");  // still pending
    expect(images.length).toBe(1);

    images[0].onload();
    ensureNodeColorSampled(1, "https://images.genius.com/a.jpg");  // already cached
    expect(images.length).toBe(1);
  });

  it("does nothing for a falsy imageUrl (no photo → caller's role-hue fallback applies)", () => {
    const images = mockLoadableImage();
    ensureNodeColorSampled(1, "");
    ensureNodeColorSampled(2, null);
    expect(images.length).toBe(0);
    expect(getCachedDominantColor(1)).toBeNull();
  });

  it("leaves the cache empty (fallback applies) when the image fails to load", () => {
    const images = mockLoadableImage();
    ensureNodeColorSampled(1, "https://images.genius.com/broken.jpg");
    images[0].onerror();
    expect(getCachedDominantColor(1)).toBeNull();
  });

  // [SF-WEB-58 B] jsdom's real HTMLCanvasElement.getContext("2d") returns
  // null (no "canvas" package installed) — the sampler must treat that as
  // "can't sample here", not throw into what could be a draw-loop callback.
  it("falls back to null (no crash) when getContext('2d') is unavailable", () => {
    const images = mockLoadableImage();
    HTMLCanvasElement.prototype.getContext = () => null;
    ensureNodeColorSampled(1, "https://images.genius.com/photo.jpg");
    expect(() => images[0].onload()).not.toThrow();
    expect(getCachedDominantColor(1)).toBeNull();
  });

  it("clearDominantColorCache() drops cached colors and lets a re-sample happen", () => {
    const images = mockLoadableImage();
    HTMLCanvasElement.prototype.getContext = () => fakeCtx(5, 5, 5);
    ensureNodeColorSampled(1, "https://images.genius.com/a.jpg");
    images[0].onload();
    expect(getCachedDominantColor(1)).not.toBeNull();

    clearDominantColorCache();
    expect(getCachedDominantColor(1)).toBeNull();
    ensureNodeColorSampled(1, "https://images.genius.com/a.jpg");
    expect(images.length).toBe(2);  // sampled again, not skipped as "already cached"
  });
});
