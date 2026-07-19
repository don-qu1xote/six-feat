// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/bubble-contours.js — [SF-WEB-58/59 C] BubbleSets-style soft
//                                  haze per hub-sector (every expanded pole
//                                  AND the seed — SF-WEB-59), drawn UNDER
//                                  nodes (and edges — same beforeDrawing
//                                  hook edge-render.js already uses, see
//                                  render.js's network.on("beforeDrawing", …)
//                                  chain, native vis.js draw happens after
//                                  every beforeDrawing listener has run).
//
// Simplified BubbleSets: true BubbleSets (Collins et al. 2009) routes a
// contour through a potential field to actively AVOID non-member nodes —
// full energy-field routing is significant extra complexity for a v1
// visual accent. This draws a padded, rounded convex hull around each
// sector's member positions instead — same "recognizable haze around a
// cluster, overlapping only where cluster membership actually overlaps"
// read, at a fraction of the cost, still fully driven by live positions
// every frame like every other custom canvas layer here (edge-render.js).
//
// Membership (layout.js::placeExpandedNodes → sectorMembers) already
// guarantees "overlap only at shared leaves": an exclusive leaf's id
// appears in exactly one hub's member set, a shared/Euler-zone leaf's id
// appears in every owning hub's set — so it is the ONLY thing whose
// position can legitimately fall inside two contours at once. Padding is
// deliberately small (NODE_GAP — the same node-to-node breathing-room
// metric layout.js uses everywhere else, not the much larger
// cluster-to-cluster gap) so a sector's haze stays close to its own
// dandelion + Euler lenses, never ballooning out past where the real
// membership actually ends.
//
// [SF-WEB-59] Color per sector: the hub's OWN sampled photo color (see
// photo-color.js), tone-mapped into a muted/neon band consistent with the
// app's palette (raw photo pixels can be anything — a dull grey avatar
// shouldn't produce an invisible haze, an oversaturated one shouldn't
// produce a jarring one) — falling back to the hub's role hue when no
// photo color is available yet, same "без фото → hue сектора" spirit as
// everywhere else in this codebase. This is the ONLY place a photo-derived
// color is used post-SF-WEB-59 (edge tint / node border tint from
// SF-WEB-58 B were reverted — a regression per the ticket).
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { roleStyle } from "../state/helpers.js";
import { getCachedDominantColor } from "./photo-color.js";
import { NODE_GAP } from "./layout.js";

// [SF-WEB-61] BubbleSets used to auto-hide past this member count (the old
// LOD safety valve). Per the ticket ("давай добавим BubbleSet отдельной
// кнопкой, которая по дефолту выключенна и не будем сами управлять ею") this
// module no longer decides on/off by itself — see State.bubbleSetsEnabled /
// the toggle button in ui/canvas-controls.js. Kept exported (unused by this
// module now) only because nothing forces removing a once-public constant;
// no code path reads it for gating anymore.
export const CONTOUR_MAX_TOTAL_MEMBERS = 600;

const FILL_ALPHA  = 0.16;   // per-sector alpha — additive blending (see draw) builds up naturally where sectors overlap
const HULL_PADDING = NODE_GAP;  // "зазор из наших вычислений длины" — the same breathing-room metric, not the larger cluster gap
const BLUR_PX      = 16;    // soft haze, not a flat sharp-edged shape

// [SF-WEB-61] Offscreen-bitmap perf cache — see _drawViaBitmapCache below.
const BITMAP_MARGIN  = BLUR_PX * 3;   // room for the blur to spread without clipping at the bitmap edge
const BITMAP_MAX_DIM = 4096;          // hard cap on offscreen canvas pixel size for extreme graphs

let _sectors = new Map();       // hubId → { ids: number[], color: "#rrggbb" }
let _pathCache = new Map();     // hubId → { key: string, points: [{x,y}] }
let _bitmap = null;             // { key, canvas, minX, minY, w, h } — see _drawViaBitmapCache

function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function _hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}

function _hslToHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = v => Math.round(_clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// [SF-WEB-60] Keeps the photo's own hue, clamps saturation/lightness into a
// band that reads as "neon but muted" regardless of how flat, dark, or
// oversaturated the raw sampled avatar pixels were — a photo dominated by a
// dull grey background still produces a visible, on-brand haze color; a
// blown-out bright pixel average doesn't produce an eye-searing one either.
// [SF-WEB-60] "приглушённым и немного неоновым КАК И СЕЙЧАС" — the band
// was originally tuned duller than the app's OWN accent palette actually
// is: COLOR.signal/pulse/amber/warn/neon (state.js) all sit at roughly
// S 73-100%, L 59-78% — a photo-toned color at the old S_MIN/L_MIN band
// (42-75% / 48-68%) read visibly flatter/muddier next to those, not "as
// vivid as now". Raised to match the palette's own real range instead of
// a guessed-lower one.
const S_MIN = 0.70, S_MAX = 1.0, L_MIN = 0.60, L_MAX = 0.80;
export function toneMutedNeon(hex) {
  const { h, s, l } = _hexToHsl(hex);
  return _hslToHex(h, Math.min(Math.max(s, S_MIN), S_MAX), Math.min(Math.max(l, L_MIN), L_MAX));
}

// [SF-WEB-58/59 C] Called alongside setEdgeCache() (render.js::
// _layoutNodeItems, physics.js::mergeNetwork) — same "recomputed only on
// layout change, not every frame" cadence.
export function setContourData(sectorMembers) {
  const next = new Map();
  if (sectorMembers && sectorMembers.size) {
    const byId = new Map(State.graphNodes.map(n => [n.id, n]));
    for (const [hubId, members] of sectorMembers) {
      const hub = byId.get(hubId);
      const photoColor = getCachedDominantColor(hubId);
      const role = hub?._dominantRole || (hub?.isSeed ? "featured" : "primary");
      const color = photoColor ? toneMutedNeon(photoColor) : roleStyle(role).color;
      next.set(hubId, { ids: [...members], color });
    }
  }
  _sectors = next;
  _pathCache = new Map();  // membership changed — any cached hull is stale
  _bitmap = null;
}

export function clearContourData() {
  _sectors = new Map();
  _pathCache = new Map();
  _bitmap = null;
}

export function _contourSectorCount() { return _sectors.size; }

// ── Pure geometry helpers (exported for testing without a canvas) ──────────

// Andrew's monotone chain — standard O(n log n) convex hull, returned
// counter-clockwise, no duplicate closing point.
export function _convexHull(points) {
  const pts = [...new Map(points.map(p => [`${p.x}:${p.y}`, p])).values()]
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = seq => {
    const hull = [];
    for (const p of seq) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  const lower = build(pts);
  const upper = build([...pts].reverse());
  return [...lower, ...upper];
}

// Pushes every hull vertex directly away from the hull's own centroid by a
// fixed extra `padding` — a cheap stand-in for a true Minkowski sum with a
// disk. Strictly enlarges (never shrinks) a convex polygon, so it still
// contains every point the un-padded hull contained.
export function _padHull(hull, padding) {
  if (hull.length < 3) return hull;
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return hull.map(p => {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const scale = (d + padding) / d;
    return { x: cx + dx * scale, y: cy + dy * scale };
  });
}

// The polygon this module's fill/point-membership both use for a sector:
// padded convex hull of its member positions. A single point (one member,
// or all members coincident) has no meaningful polygon — returns [].
export function computeSectorPolygon(memberPositions, padding = HULL_PADDING) {
  if (memberPositions.length < 2) return [];
  const hull = _convexHull(memberPositions);
  if (hull.length < 3) {
    // Collinear (or coincident) members — no true 2D hull to pad via
    // _padHull (undefined without ≥3 points to define a centroid-relative
    // shape), and padding purely ALONG the same line would still be a
    // zero-area line, not a real polygon (pointInPolygon is meaningless on
    // that). Fall back to the padded axis-aligned bounding box instead —
    // trivially contains every member with margin on every side, and is a
    // real 2D quad no matter how degenerate the input (even a single
    // repeated point becomes a small padded square).
    const xs = memberPositions.map(p => p.x), ys = memberPositions.map(p => p.y);
    const minX = Math.min(...xs) - padding, maxX = Math.max(...xs) + padding;
    const minY = Math.min(...ys) - padding, maxY = Math.max(...ys) + padding;
    return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  }
  return _padHull(hull, padding);
}

// Standard ray-casting point-in-polygon.
export function pointInPolygon(pt, polygon) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersects = (yi > pt.y) !== (yj > pt.y) &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ── Drawing ─────────────────────────────────────────────────────────────

function _quantize(positions, ids) {
  // Cache key: round every member's live position to 2px — the hull is a
  // decorative fill, sub-pixel repositioning (e.g. mid-physics micro-jitter)
  // isn't worth a recompute, but any real movement (drag, flyout animation,
  // pan-independent since ctx is already in world space) invalidates it.
  let key = "";
  for (const id of ids) {
    const p = positions[id];
    key += p ? `${Math.round(p.x / 2)},${Math.round(p.y / 2)}|` : "∅|";
  }
  return key;
}

function _tracePath(ctx, points) {
  // Smooth closed shape through `points` via the classic "curve through
  // midpoints" trick: moveTo the midpoint before the first vertex, then
  // quadraticCurveTo each vertex using the midpoint to the NEXT vertex as
  // the curve's endpoint — every vertex acts as a control point pulling the
  // curve toward it without the path passing through the (sharper) raw
  // polygon corners.
  const n = points.length;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const m0 = mid(points[n - 1], points[0]);
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) {
    const next = points[(i + 1) % n];
    const m = mid(points[i], next);
    ctx.quadraticCurveTo(points[i].x, points[i].y, m.x, m.y);
  }
}

function _offscreenSupported() {
  if (typeof document === "undefined" || !document.createElement) return false;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext && c.getContext("2d");
    // Duck-type check, not just truthiness: photo-color.js's own tests stub
    // HTMLCanvasElement.prototype.getContext globally for image-sampling
    // purposes with a much narrower mock (drawImage/getImageData only) — a
    // plain existence check would wrongly treat that as full 2D-canvas
    // support and crash on the first real draw call (scale/translate/fill).
    return !!(ctx && typeof ctx.scale === "function" && typeof ctx.translate === "function" && typeof ctx.fill === "function");
  } catch {
    return false;
  }
}

function _compositeKey(paths) {
  // Cache key for the WHOLE composited bitmap — paths already carry
  // 2px-quantized hull points (via _pathCache/_quantize above), so re-using
  // their rounded coordinates directly is enough to detect "nothing about
  // the actual geometry changed since last frame" without a second pass.
  let key = "";
  for (const { color, points } of paths) {
    key += color + ":";
    for (const p of points) key += `${Math.round(p.x)},${Math.round(p.y)}|`;
    key += ";";
  }
  return key;
}

function _computeBBox(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { points } of paths) {
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return {
    minX: minX - BITMAP_MARGIN, minY: minY - BITMAP_MARGIN,
    w: (maxX - minX) + BITMAP_MARGIN * 2, h: (maxY - minY) + BITMAP_MARGIN * 2,
  };
}

function _fillPaths(destCtx, paths) {
  destCtx.globalCompositeOperation = "lighter";
  destCtx.filter = `blur(${BLUR_PX}px)`;
  destCtx.globalAlpha = FILL_ALPHA;
  for (const { color, points } of paths) {
    destCtx.fillStyle = color;
    destCtx.beginPath();
    _tracePath(destCtx, points);
    destCtx.closePath();
    destCtx.fill();
  }
  destCtx.globalAlpha = 1;
}

// [SF-WEB-59] "лёгкая дымка... смешивая цвета" — soft blur (not a flat
// sharp-edged shape) plus additive ("lighter") blending, so two overlapping
// sectors' hazes visually mix into a brighter blended hue exactly where
// their membership genuinely overlaps (a shared/Euler leaf sitting inside
// both), and read as one soft cloud everywhere else. No caching — used only
// where an offscreen canvas isn't available (see _offscreenSupported).
function _drawDirect(ctx, paths) {
  const hadFilter = "filter" in ctx;
  const prevComposite = ctx.globalCompositeOperation;
  const prevFilter = hadFilter ? ctx.filter : undefined;
  if (hadFilter) {
    _fillPaths(ctx, paths);
  } else {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = FILL_ALPHA;
    for (const { color, points } of paths) {
      ctx.fillStyle = color;
      ctx.beginPath();
      _tracePath(ctx, points);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (hadFilter) ctx.filter = prevFilter;
  ctx.globalCompositeOperation = prevComposite;
}

// [SF-WEB-61] "обновление должно быть только при явных [изменениях]" —
// ctx.filter blur is the expensive part of this layer, and drawContours
// used to re-run the full blur+additive fill on EVERY animation frame
// (every pan, every zoom, every physics tick) even though nothing about the
// actual sector geometry had moved. Bakes the composited haze into an
// offscreen bitmap ONCE per genuine geometry change (same quantized-key
// idea _pathCache already uses per-hub, just combined across the whole
// picture) — every subsequent frame is then just a plain drawImage() blit
// in world coordinates, which the live pan/zoom transform on `ctx` applies
// automatically, same as any other image layer.
function _drawViaBitmapCache(ctx, paths) {
  const key = _compositeKey(paths);
  if (!_bitmap || _bitmap.key !== key) {
    const { minX, minY, w, h } = _computeBBox(paths);
    const scale = Math.min(1, BITMAP_MAX_DIM / Math.max(w, h, 1));
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.ceil(w * scale));
    off.height = Math.max(1, Math.ceil(h * scale));
    const octx = off.getContext("2d");
    octx.scale(scale, scale);
    octx.translate(-minX, -minY);
    _fillPaths(octx, paths);
    _bitmap = { key, canvas: off, minX, minY, w, h };
  }
  ctx.drawImage(_bitmap.canvas, _bitmap.minX, _bitmap.minY, _bitmap.w, _bitmap.h);
}

export function drawContours(ctx) {
  // [SF-WEB-61] Manual toggle only — no more auto show/hide by node count
  // (see CONTOUR_MAX_TOTAL_MEMBERS's own comment above).
  if (!State.bubbleSetsEnabled) return;
  if (!_sectors.size || !State.network) return;

  const positions = State.network.getPositions();
  const paths = [];  // { color, points } — collected first, drawn together under one blend/blur state

  for (const [hubId, { ids, color }] of _sectors) {
    const memberPositions = ids.map(id => positions[id]).filter(Boolean);
    if (memberPositions.length < 2) continue;  // nothing to enclose

    const key = _quantize(positions, ids);
    let cached = _pathCache.get(hubId);
    if (!cached || cached.key !== key) {
      cached = { key, points: computeSectorPolygon(memberPositions) };
      _pathCache.set(hubId, cached);
    }
    if (cached.points.length < 3) continue;
    paths.push({ color, points: cached.points });
  }
  if (!paths.length) return;

  if (_offscreenSupported()) {
    _drawViaBitmapCache(ctx, paths);
  } else {
    _drawDirect(ctx, paths);
  }
}
