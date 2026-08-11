import { State } from "../state/state.js";
import { els } from "../dom/dom.js";

export function showToast(message, ms = 4800, isInfo = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("toast--info", isInfo);
  els.toast.classList.remove("has-action");
  els.toast.classList.add("show");
  if (State.toastTimer) clearTimeout(State.toastTimer);
  State.toastTimer = setTimeout(hideToast, ms);
}

export function showRetryToast(message, retry, ms = 8000) {
  els.toast.textContent = "";
  els.toast.append(message + " ");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-retry-btn";
  btn.textContent = "Retry";
  btn.addEventListener("click", () => {
    hideToast();
    retry();
  });
  els.toast.appendChild(btn);
  els.toast.classList.remove("toast--info");
  els.toast.classList.add("show", "has-action");
  if (State.toastTimer) clearTimeout(State.toastTimer);
  State.toastTimer = setTimeout(hideToast, ms);
}

export function hideToast() {
  els.toast.classList.remove("show", "toast--info", "has-action");
  if (State.toastTimer) {
    clearTimeout(State.toastTimer);
    State.toastTimer = null;
  }
}
