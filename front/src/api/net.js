const DEFAULT_STATUS_MESSAGES = {
  400: "Request was rejected by the server.",
  429: "Too many requests — try again in a moment.",
  502: "Couldn't reach Genius. Try again in a moment.",
  503: "Genius is temporarily unavailable — please try again in a minute, recovery is underway.",
};

const TRANSIENT_STATUSES = new Set([502, 503]);

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
    notSignedInMessage = "Sign in with Genius to continue.",
    tokenInvalidDelay = 1500,
    notSignedInDelay = 1200,
  } = overrides;

  return body?.error === "token_invalid"
    ? { message: tokenInvalidMessage, delay: tokenInvalidDelay }
    : { message: notSignedInMessage, delay: notSignedInDelay };
}

export function redirectToLogin(showToastFn, body, overrides = {}) {
  const { message, delay } = authErrorInfo(body, overrides);
  showToastFn(message);
  setTimeout(() => {
    window.location.href = "/auth/login";
  }, delay);
}
