import { State } from "../state/state.js";
import { proxiedImageUrl } from "../state/helpers.js";

const SAMPLE_SIZE = 12;

const _colorCache = new Map();
const _pending = new Set();
export function getCachedDominantColor(nodeId) {
  return _colorCache.get(nodeId) || null;
}

function _averageColorFromImage(img) {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let data;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return null;
  }
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  if (!n) return null;
  const toHex = (v) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function ensureNodeColorSampled(nodeId, imageUrl) {
  if (!imageUrl || _colorCache.has(nodeId) || _pending.has(nodeId)) return;
  _pending.add(nodeId);

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    _pending.delete(nodeId);
    const color = _averageColorFromImage(img);
    if (color) {
      _colorCache.set(nodeId, color);
      if (State.network) State.network.redraw();
    }
  };
  img.onerror = () => {
    _pending.delete(nodeId);
  };
  img.src = proxiedImageUrl(imageUrl);
}

export function clearDominantColorCache() {
  _colorCache.clear();
  _pending.clear();
}
