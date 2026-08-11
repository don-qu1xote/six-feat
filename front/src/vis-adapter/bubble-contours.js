import { State } from "../state/state.js";
import { roleStyle } from "../state/helpers.js";

const FILL_ALPHA = 0.16;
const BLUR_PX = 16;
const BITMAP_MARGIN = BLUR_PX * 3;
const BITMAP_MAX_DIM = 4096;

/**
 * [SF-API-22] Готовые контуры от раскладки: hub, цвет и точки обвода.
 *
 * Геометрия (оболочка, отступ, состав групп) переехала в
 * libs/six-feat-layout/src/contours.cpp и приезжает в ответе
 * POST /api/v1/graph/layout. Здесь остаётся то, что и должно быть у клиента:
 * цвет по данным артиста и рисование.
 */
let _paths = [];
let _bitmap = null;
function _clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function _hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
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
  const toHex = (v) =>
    Math.round(_clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const S_MIN = 0.7,
  S_MAX = 1.0,
  L_MIN = 0.6,
  L_MAX = 0.8;
export function toneMutedNeon(hex) {
  const { h, s, l } = _hexToHsl(hex);
  return _hslToHex(h, Math.min(Math.max(s, S_MIN), S_MAX), Math.min(Math.max(l, L_MIN), L_MAX));
}

export function setContourData(contours) {
  const next = [];
  if (contours && contours.length) {
    const byId = new Map(State.graphNodes.map((n) => [n.id, n]));
    for (const contour of contours) {
      const points = contour && contour.points;
      if (!points || points.length < 3) continue;
      const hub = byId.get(contour.hub);
      // [SF-API-20] Цвет фотографии приходит с узлом (сервер считает его один
      // раз на артиста). Нет его — контур красится ролью, ровно как красился
      // раньше, пока фотография ещё не загрузилась.
      const photoColor = hub?.dominantColor || null;
      const role = hub?._dominantRole || (hub?.isSeed ? "featured" : "primary");
      const color = photoColor ? toneMutedNeon(photoColor) : roleStyle(role).color;
      next.push({ hub: contour.hub, color, points });
    }
  }
  _paths = next;
  _bitmap = null;
}

export function clearContourData() {
  _paths = [];
  _bitmap = null;
}

export function _contourSectorCount() {
  return _paths.length;
}

function _tracePath(ctx, points) {
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
    return !!(
      ctx &&
      typeof ctx.scale === "function" &&
      typeof ctx.translate === "function" &&
      typeof ctx.fill === "function"
    );
  } catch {
    return false;
  }
}

function _compositeKey(paths) {
  let key = "";
  for (const { color, points } of paths) {
    key += color + ":";
    for (const p of points) key += `${Math.round(p.x)},${Math.round(p.y)}|`;
    key += ";";
  }
  return key;
}

function _computeBBox(paths) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const { points } of paths) {
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return {
    minX: minX - BITMAP_MARGIN,
    minY: minY - BITMAP_MARGIN,
    w: maxX - minX + BITMAP_MARGIN * 2,
    h: maxY - minY + BITMAP_MARGIN * 2,
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
  if (!State.bubbleSetsEnabled) return;
  if (!_paths.length) return;

  if (_offscreenSupported()) {
    _drawViaBitmapCache(ctx, _paths);
  } else {
    _drawDirect(ctx, _paths);
  }
}
