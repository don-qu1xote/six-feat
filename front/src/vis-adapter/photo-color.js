// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/photo-color.js — [SF-WEB-58 B] dominant-color sampling from a
//                              node's real avatar, for tinting its cross-
//                              sector arcs (edge-render.js) and/or its border
//                              (visuals.js::nodeVisual) instead of the flat
//                              role hue every node without a photo still uses.
//
// The LIVE #network canvas paints avatars straight from vis.js's own
// circularImage renderer, sourced from the same-origin proxy (SF-API-12,
// see state/helpers.js::proxiedImageUrl) — but that canvas is shared with
// everything else vis.js draws and is not ours to getImageData() from
// mid-render. Sampling instead loads a SECOND, disposable same-origin
// <img> (same proxy URL, so no CORS taint — see canvas-controls.js's
// export-path comment for the identical reasoning) into its own tiny
// offscreen canvas purely to average its pixels. Result is cached by node
// id — sampling only ever happens once per node per page load.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { proxiedImageUrl } from "../state/helpers.js";

// Downscaled sample size — large enough for a stable average, small enough
// that drawImage+getImageData is effectively free (144 pixels).
const SAMPLE_SIZE = 12;

const _colorCache = new Map();   // nodeId → "#rrggbb"
const _pending     = new Set();  // nodeId currently loading — avoid duplicate fetch/decode

export function getCachedDominantColor(nodeId) {
  return _colorCache.get(nodeId) || null;
}

function _averageColorFromImage(img) {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return null;  // no 2d canvas support in this environment — skip, not fatal
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let data;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return null;  // tainted/unreadable — fall back to role hue, never throw into a draw loop
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;  // skip near-transparent pixels (padding/rounded corners)
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  if (!n) return null;
  const toHex = v => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Kicks off (idempotently — cached/pending nodes are a no-op) an async
// sample of `imageUrl` for `nodeId`. Fire-and-forget: callers read the
// result later via getCachedDominantColor, once it's ready. A successful
// sample triggers network.redraw() so cross-arcs/borders waiting on it
// repaint with the real color on the very next frame instead of only after
// some unrelated redraw happens to fire.
export function ensureNodeColorSampled(nodeId, imageUrl) {
  if (!imageUrl || _colorCache.has(nodeId) || _pending.has(nodeId)) return;
  _pending.add(nodeId);

  const img = new Image();
  img.crossOrigin = "anonymous";  // same-origin proxy — never actually triggers a CORS fetch
  img.onload = () => {
    _pending.delete(nodeId);
    const color = _averageColorFromImage(img);
    if (color) {
      _colorCache.set(nodeId, color);
      if (State.network) State.network.redraw();
    }
  };
  img.onerror = () => { _pending.delete(nodeId); };
  img.src = proxiedImageUrl(imageUrl);
}

// Full graph reset (resetCanvasToEmpty/clearGraphForPathSearch/new seed) —
// node ids are not guaranteed unique across an unrelated graph, and a stale
// cached color from a previous artist's avatar must never bleed into a new
// graph that happens to reuse a numeric id.
export function clearDominantColorCache() {
  _colorCache.clear();
  _pending.clear();
}
