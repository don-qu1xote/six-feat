// ════════════════════════════════════════════════════════════════════════════
// transition.js — ТЗ-D4: shared hero ↔ graph transition
//
// Two layers, in order of preference:
//   1. Native View Transitions API (Chrome/Edge): the browser handles the
//      cross-fade/morph itself via `view-transition-name: search-morph` on
//      .search-wrap (see index.html). We just wrap the DOM mutation.
//   2. Manual FLIP fallback (Firefox/Safari/older browsers): clone the hero
//      search-wrap, position it absolutely over its own start rect, then
//      animate it via WAAPI from start rect → end rect (the rail's search
//      button), while the real search-wrap fades out under it.
//
// `prefers-reduced-motion` users get neither — the mutation just runs.
// ════════════════════════════════════════════════════════════════════════════
import { els, $ } from "./dom.js";
import { MOTION, readCssVar, prefersReducedMotion } from "../state/state.js";

// [SF-WEB-47] --ease-emphasized (styles/tokens.css) — this file used to
// hardcode the same cubic-bezier() string directly; reading it live means
// this curve and the token can never drift apart. Fallback matches the
// token's own default value (see tokens.css) for non-browser test envs.
const EMPHASIZED_EASING = () => readCssVar("--ease-emphasized", "cubic-bezier(.16,.9,.3,1)");

const supportsViewTransitions = () =>
  typeof document.startViewTransition === "function";

/**
 * Run `mutate` (a synchronous DOM-mutation function, e.g. toggling
 * .is-hidden/.is-visible classes) wrapped in whichever transition
 * mechanism is available.
 *
 * @param {Function} mutate   - synchronous function applying the DOM change
 * @param {"toGraph"|"toHero"} direction - which way we're morphing
 */
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
  // The element the search-wrap should visually travel to/from.
  // Going TO the graph, it heads toward the rail's search icon.
  // Coming BACK to the modal, it originates from that same icon.
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

  // Mark the modal as "morphing" so CSS keeps the real search-wrap visible
  // (not faded) while our ghost clone animates on top of it.
  els.searchModal?.classList.add("is-morphing");

  mutate();

  // After mutation, figure out where things ended up so we can animate
  // a clone from start → end without ever animating layout properties.
  requestAnimationFrame(() => {
    const endRect = target.getBoundingClientRect();

    const ghost = searchWrap.cloneNode(true);
    ghost.classList.add("flip-ghost");
    ghost.style.left = `${startRect.left}px`;
    ghost.style.top = `${startRect.top}px`;
    ghost.style.width = `${startRect.width}px`;
    ghost.style.height = `${startRect.height}px`;
    document.body.appendChild(ghost);

    // Hide the real search-wrap immediately now that the ghost
    // is standing in for it; the rest of the modal fades per the CSS.
    searchWrap.style.visibility = "hidden";

    const scaleX = endRect.width / startRect.width;
    const scaleY = endRect.height / startRect.height;
    const dx = (endRect.left + endRect.width / 2) - (startRect.left + startRect.width / 2);
    const dy = (endRect.top + endRect.height / 2) - (startRect.top + startRect.height / 2);

    const anim = ghost.animate(
      [
        { transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(${Math.max(scaleX, .35)}, ${Math.max(scaleY, .35)})`, opacity: 0 }
      ],
      { duration: MOTION.flight, easing: EMPHASIZED_EASING(), fill: "forwards" }
    );

    anim.finished.finally(() => {
      ghost.remove();
      searchWrap.style.visibility = "";
      els.searchModal?.classList.remove("is-morphing");
    });
  });
}
