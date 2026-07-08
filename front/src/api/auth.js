// ════════════════════════════════════════════════════════════════════════════
// auth.js — OAuth session UI state
//
// [ТЗ-6] Login with Genius is mandatory — there is no server-level fallback
// token anymore, and the API rejects unauthenticated requests with 401.
//
// On page load, checkAuth() asks GET /auth/me whether the browser holds a valid
// six_feat_session cookie. If so, it swaps the hero "sign in" hint for the
// signed-in user's name + sign-out link, and reveals the "🔑 my token" badge in
// the graph dock. Signed-out users see the sign-in hint and are redirected to
// /auth/login the moment they try to search (see api.js's 401 handling).
//
// The session cookie is HttpOnly — JS cannot read the token. /auth/me is the
// only way the front end learns auth state, and it never exposes the token.
// ════════════════════════════════════════════════════════════════════════════

import { $ } from "../dom/dom.js";
import { showToast } from "../ui/index.js";
import { apiFetch } from "./net.js";

// [F-38] Read the `six_feat_csrf` double-submit cookie (set by
// CallbackHandler on successful login, deliberately not HttpOnly) so it can
// be echoed back as the X-CSRF-Token header on POST /auth/logout.
function getCookie(name) {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

// Surface ?auth=denied / ?auth=error redirects from /auth/callback as a toast,
// then strip the param so a refresh doesn't repeat it.
function handleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const a = params.get("auth");
  if (!a) return;
  if (a === "denied") showToast("Genius sign-in was cancelled.");
  else if (a === "error") showToast("Sign-in failed — please try again.");
  params.delete("auth");
  const qs = params.toString();
  const clean = window.location.pathname + (qs ? `?${qs}` : "");
  window.history.replaceState({}, "", clean);
}

export async function checkAuth() {
  handleAuthRedirect();

  let data = { authenticated: false };
  try {
    const res = await apiFetch("/auth/me", { headers: { Accept: "application/json" } });
    if (res.ok) data = await res.json();
  } catch (_) {
    // Network error or not signed in — fall through to signed-out state.
  }

  const hint   = $("auth-hint");
  const user   = $("auth-user");
  const name   = $("auth-user-name");
  const badge  = $("auth-status-badge");

  if (data.authenticated) {
    if (hint)  hint.style.display = "none";
    if (user)  user.style.display = "flex";
    if (name)  name.textContent = data.name || "Genius User";
    if (badge) badge.style.display = "inline-flex";
  } else {
    if (hint)  hint.style.display = "flex";
    if (user)  user.style.display = "none";
    if (badge) badge.style.display = "none";
  }

  return data;
}

// [F-38] logout is now POST-only (a GET made it triggerable cross-site via a
// bare <img src>), so it must go through fetch() rather than a plain <a
// href>. The X-CSRF-Token header echoes the six_feat_csrf double-submit
// cookie back to the server as defense in depth on top of the
// SameSite=Strict session cookie.
export function initLogout() {
  const btn = $("auth-logout-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await fetch("/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": getCookie("six_feat_csrf") || "" },
      });
    } finally {
      window.location.href = "/";
    }
  });
}
