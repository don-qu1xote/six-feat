import { els, $ } from "./dom.js";
import { MOTION, readCssVar, prefersReducedMotion } from "../state/state.js";

const EMPHASIZED_EASING = () => readCssVar("--ease-emphasized", "cubic-bezier(.16,.9,.3,1)");

const supportsViewTransitions = () => typeof document.startViewTransition === "function";

export function runHeroGraphTransition(mutate, direction) {
  if (prefersReducedMotion()) {
    mutate();
    return;
  }

  if (supportsViewTransitions()) {
    els.searchModal?.classList.add("is-morphing");
    const vt = document.startViewTransition(() => mutate());
    vt.finished.finally(() => els.searchModal?.classList.remove("is-morphing"));
    return;
  }

  runFlipFallback(mutate, direction);
}

function getMorphTarget(direction) {
  return $("btn-search-open");
}

function runFlipFallback(mutate, direction) {
  const searchWrap = els.searchModal?.querySelector(".search-wrap");
  const target = getMorphTarget(direction);

  if (!searchWrap || !target) {
    mutate();
    return;
  }

  const startRect = searchWrap.getBoundingClientRect();

  els.searchModal?.classList.add("is-morphing");

  mutate();

  requestAnimationFrame(() => {
    const endRect = target.getBoundingClientRect();

    const ghost = searchWrap.cloneNode(true);
    ghost.classList.add("flip-ghost");
    ghost.style.left = `${startRect.left}px`;
    ghost.style.top = `${startRect.top}px`;
    ghost.style.width = `${startRect.width}px`;
    ghost.style.height = `${startRect.height}px`;
    document.body.appendChild(ghost);

    searchWrap.style.visibility = "hidden";

    const scaleX = endRect.width / startRect.width;
    const scaleY = endRect.height / startRect.height;
    const dx = endRect.left + endRect.width / 2 - (startRect.left + startRect.width / 2);
    const dy = endRect.top + endRect.height / 2 - (startRect.top + startRect.height / 2);

    const anim = ghost.animate(
      [
        { transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 },
        {
          transform: `translate(${dx}px, ${dy}px) scale(${Math.max(scaleX, 0.35)}, ${Math.max(scaleY, 0.35)})`,
          opacity: 0,
        },
      ],
      { duration: MOTION.flight, easing: EMPHASIZED_EASING(), fill: "forwards" },
    );

    anim.finished.finally(() => {
      ghost.remove();
      searchWrap.style.visibility = "";
      els.searchModal?.classList.remove("is-morphing");
    });
  });
}
