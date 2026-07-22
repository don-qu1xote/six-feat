// ════════════════════════════════════════════════════════════════════════════
// helpers.js — Pure utility functions with no side-effects
// ════════════════════════════════════════════════════════════════════════════
import { State, COLOR, ROLE_PRIORITY, ROLE_STYLE } from "./state.js";

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function initialOf(name) {
  const m = (name || "").trim().match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : "?").toUpperCase();
}

export function debounce(fn, ms) {
  let t;
  const debounced = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  debounced.cancel = () => clearTimeout(t);
  return debounced;
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function graphHash() {
  return State.graphEdges.map(e => `${e.from}-${e.to}`).sort().join("|");
}

// ────────────────────────────────────────────────────────────────────────────
// Genius default-image detection
// ────────────────────────────────────────────────────────────────────────────
// [SF-WEB-16] Front-end defense in depth: SF-API-07 already normalizes this
// away server-side (GeniusGateway::ParseArtistObject/ResolveCandidates/
// FetchArtistById → NormalizeArtistImageUrl,
// libs/six-feat-common/src/genius/genius_gateway.cpp), but if a URL like it
// ever slips through unfiltered, treat it as "no photo" here too rather than
// rendering Genius's own grey placeholder graphic. Genius's fallback image
// is a real, resolvable URL (not a 404 or empty string) with a cache-busting
// query string appended, so it can't be told apart from a real photo by
// validity alone — every observed variant (regardless of host/size) is
// served from the fixed path assets.genius.com/images/default_cover_image.png
// (e.g. https://assets.genius.com/images/default_cover_image.png?1783625229);
// matched as a substring so the query string doesn't matter.
export const GENIUS_DEFAULT_IMAGE_MARKER = "default_cover_image";

export function isGeniusDefaultAvatar(url) {
  return typeof url === "string" && url.includes(GENIUS_DEFAULT_IMAGE_MARKER);
}

// [SF-WEB-58 B] Same-origin proxy URL for a Genius CDN image (SF-API-12) —
// re-serves the allowlisted bytes from THIS origin so a canvas that draws
// it never taints. Previously inlined separately in canvas-controls.js's
// export path (buildShadowNodes) — now the one place both that and
// vis-adapter/photo-color.js (dominant-color sampling) build this URL from.
export function proxiedImageUrl(rawUrl) {
  return `/api/v1/image?url=${encodeURIComponent(rawUrl)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Placeholder avatar SVG
// ────────────────────────────────────────────────────────────────────────────
// [SF-WEB-16] Background/accent are read live from the active theme's CSS
// custom properties (COLOR.panel/signal/pulse — see state.js's readCssVar),
// not hardcoded, so the placeholder actually matches dark or light mode.
// _phCache is additionally keyed by State.theme: theme.js's recolorInPlace
// (vis-adapter/highlight.js) re-calls this for every photo-less node after
// a theme toggle, and without the theme in the key it would just hand back
// the other theme's cached (now wrong-coloured) SVG.
const _phCache = new Map();

export function placeholderFor(name, isSeed) {
  const accent = isSeed ? COLOR.signal : COLOR.pulse;
  const bg     = COLOR.panel;
  const letter = initialOf(name);
  const key    = `${letter}|${isSeed ? "s" : "p"}|${State.theme}`;
  if (_phCache.has(key)) return _phCache.get(key);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'>` +
    `<rect width='120' height='120' fill='${bg}'/>` +
    `<circle cx='60' cy='60' r='54' fill='none' stroke='${accent}' stroke-opacity='0.30' stroke-width='2'/>` +
    `<text x='60' y='60' dy='.35em' text-anchor='middle' font-family='Inter,sans-serif' ` +
    `font-size='52' font-weight='700' fill='${accent}'>${escapeHtml(letter)}</text>` +
    `</svg>`;
  const uri = "data:image/svg+xml," + encodeURIComponent(svg);
  _phCache.set(key, uri);
  return uri;
}

// Avatar <img> tags injected via innerHTML fall back to placeholderFor() on
// load failure via a data-fallback attribute instead of an inline
// onerror="..." handler, since the latter is blocked by the page's CSP
// script-src (no 'unsafe-inline'). "error" doesn't bubble, so this needs
// the capture phase.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.dataset.fallback &&
      img.src !== img.dataset.fallback) {
    img.src = img.dataset.fallback;
  }
}, true);

// ────────────────────────────────────────────────────────────────────────────
// Role helpers
// ────────────────────────────────────────────────────────────────────────────

export function dominantRoleFromCollabs(collaborations) {
  const set = new Set();
  for (const c of (collaborations || []))
    for (const r of (c.roles || [])) set.add(r.toLowerCase());
  for (const r of ROLE_PRIORITY) if (set.has(r)) return r;
  return "primary";
}

export function allRolesFromCollabs(collaborations) {
  const set = new Set();
  for (const c of (collaborations || []))
    for (const r of (c.roles || [])) set.add(r.toLowerCase());
  return [...set];
}

export function roleStyle(role) { return ROLE_STYLE[role] || ROLE_STYLE.primary; }

// Collaborations ranked by the server-supplied popularity metric
// (collaboration.popularity, sourced from Genius stats.pageviews — see
// graph_handler.cpp), highest first. Array.prototype.sort is stable, so
// entries sharing a popularity value (including the common "no data" case
// where every value is 0/undefined) keep their original incidence order.
export function sortByPopularity(collaborations) {
  return [...(collaborations || [])].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

// ────────────────────────────────────────────────────────────────────────────
// Glow brightening for better contrast on dark background
// ────────────────────────────────────────────────────────────────────────────
// Convert hex color to HSL, increase lightness by fixed amount (capped at 90%),
// convert back to hex. Used for node glow/highlight to make them pop against
// dark canvas background.

export function brighten(hexColor, amount = 18) {
  // Normalize hex (handle 3-digit and 6-digit formats)
  let hex = (hexColor || "#000000").replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex.split("").map(c => c + c).join("");
  }
  
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h, s;
  
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  
  // Increase lightness, but cap at 90% to avoid washing out
  let newL = Math.min(0.90, l + amount / 100);
  
  // Convert back to RGB
  const hslToRgb = (h, s, l) => {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hslToRgbComponent(p, q, h + 1/3);
      g = hslToRgbComponent(p, q, h);
      b = hslToRgbComponent(p, q, h - 1/3);
    }
    return [
      Math.round(r * 255),
      Math.round(g * 255),
      Math.round(b * 255)
    ];
  };
  
  const hslToRgbComponent = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  
  const [rNew, gNew, bNew] = hslToRgb(h, s, newL);
  return `#${rNew.toString(16).padStart(2, "0")}${gNew.toString(16).padStart(2, "0")}${bNew.toString(16).padStart(2, "0")}`;
}
