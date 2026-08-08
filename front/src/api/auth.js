import { $ } from "../dom/dom.js";
import { showToast } from "../ui/index.js";
import { openSettingsPanel, refreshSettingsStatus } from "../ui/settings-panel.js";
import { t } from "../i18n/i18n.js";
import { apiFetch } from "./net.js";

function getCookie(name) {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function handleGeniusLinkRedirect(params) {
  const status = params.get("genius_link");
  if (!status) return false;
  if (status === "connected") {
    showToast(t("auth.geniusLinkedToast"));
    openSettingsPanel();
    refreshSettingsStatus();
  } else if (status === "denied") {
    showToast(t("auth.geniusLinkDeniedToast"));
  } else if (status === "error") {
    showToast(t("auth.geniusLinkErrorToast"));
  }
  params.delete("genius_link");
  return true;
}

function handleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  let changed = handleGeniusLinkRedirect(params);

  const a = params.get("auth");
  if (a) {
    if (a === "denied") showToast(t("auth.signInCancelled"));
    else if (a === "error") showToast(t("auth.signInFailed"));
    params.delete("auth");
    changed = true;
  }

  if (!changed) return;
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
  } catch (_) {}

  const hint = $("auth-hint");
  const user = $("auth-user");
  const name = $("auth-user-name");
  const badge = $("auth-status-badge");

  if (data.authenticated) {
    if (hint) hint.style.display = "none";
    if (user) user.style.display = "flex";
    if (name) name.textContent = data.name || t("auth.geniusUser");
    if (badge) badge.style.display = "inline-flex";
  } else {
    if (hint) hint.style.display = "flex";
    if (user) user.style.display = "none";
    if (badge) badge.style.display = "none";
  }

  return data;
}

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
