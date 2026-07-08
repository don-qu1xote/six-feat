// ════════════════════════════════════════════════════════════════════════════
// net.js — single helper for frontend fetch() calls (IDEA-24).
//
// Error handling for graph/path/search/me requests used to be duplicated
// (and drifting) across api.js and ui/path-result.js: each call site built
// its own 400/429/502/503 → message mapping, its own 401 → redirect-to-login
// branch, and had no way to retry a transient failure. This module centralizes
// the parts that are actually shared:
//   - apiFetch(url, opts): thin fetch() wrapper — AbortError passes through
//     untouched, any other fetch()-level rejection (offline, DNS, dropped
//     connection…) is normalized into a plain Error carrying the same
//     `.transient` marker as a 502/503, so callers can treat "no response at
//     all" and "5xx response" the same way (see isTransientStatus below).
//   - messageForStatus/throwForStatus: the 400/429/502/503 → user message
//     mapping, with per-call-site overrides for the messages that
//     legitimately differ (e.g. a 400 means "empty artist name" on the graph
//     endpoint but "limit rejected" on the show-more endpoint).
//   - authErrorInfo: resolves the 401 token_invalid vs. not-signed-in message
//     + redirect delay shared by the graph and path endpoints (the caller
//     still owns showing it — this module has no DOM/UI dependency of its
//     own, so it stays trivially testable and side-effect free).
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_STATUS_MESSAGES = {
  400: "Request was rejected by the server.",
  429: "Too many requests — try again in a moment.",
  502: "Couldn't reach Genius. Try again in a moment.",
  503: "Genius is temporarily unavailable — please try again in a minute, recovery is underway.",
};

const TRANSIENT_STATUSES = new Set([502, 503]);

// `status == null` covers the network-failure case below (no HTTP response
// was ever received, so there is no status code to check).
export function isTransientStatus(status) {
  return status == null || TRANSIENT_STATUSES.has(status);
}

export function messageForStatus(status, overrides = {}) {
  return overrides[status] || DEFAULT_STATUS_MESSAGES[status] || `Request failed (HTTP ${status}).`;
}

export function throwForStatus(status, overrides = {}) {
  const err = new Error(messageForStatus(status, overrides));
  err.status = status;
  err.transient = isTransientStatus(status);
  throw err;
}

export async function apiFetch(url, opts = {}) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    const netErr = new Error("Network error — check your connection and try again.");
    netErr.name = "NetworkError";
    netErr.status = null;
    netErr.transient = true;
    throw netErr;
  }
}

export function authErrorInfo(body, overrides = {}) {
  const {
    tokenInvalidMessage = "Your Genius token expired — please sign in again.",
    notSignedInMessage  = "Sign in with Genius to continue.",
    tokenInvalidDelay   = 1500,
    notSignedInDelay    = 1200,
  } = overrides;

  return body?.error === "token_invalid"
    ? { message: tokenInvalidMessage, delay: tokenInvalidDelay }
    : { message: notSignedInMessage, delay: notSignedInDelay };
}

// Shared side-effecting half of the 401 flow: show the message, then redirect
// to /auth/login after `delay`. Takes the caller's own showToast so it keeps
// using whichever module/mock that call site already imports.
export function redirectToLogin(showToastFn, body, overrides = {}) {
  const { message, delay } = authErrorInfo(body, overrides);
  showToastFn(message);
  setTimeout(() => { window.location.href = "/auth/login"; }, delay);
}
