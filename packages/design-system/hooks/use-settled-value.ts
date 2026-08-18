"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// The leading-edge apply has to land BEFORE paint, or the frame that renders is
// fitted against the pre-measurement seed and the layout visibly jumps once the
// real value arrives (codex + stage review). `useContainerWidth` — the motivating
// source — publishes its first real width from a LAYOUT effect, so a passive
// effect here is always one painted frame behind it. React never runs a layout
// effect on the server, so fall back to `useEffect` there; there is nothing to
// paint without a DOM, and this avoids React's "useLayoutEffect does nothing on
// the server" warning during SSR.
const useSettleEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;

/**
 * The value, held still until it stops changing (ISS-4906).
 *
 * Returns `value` verbatim while `settleMs` is `0` or negative, so a caller that
 * has not opted in is byte-identical to reading the source value directly. With
 * a positive `settleMs`, the FIRST change is applied immediately and every
 * change after it lands only once `settleMs` has passed with no further change —
 * a trailing debounce with a leading first edge.
 *
 * That first-edge asymmetry is the point, not an optimisation. The motivating
 * consumer is `GridTable`'s whole-column fold fit, whose source is a
 * `ResizeObserver` width: the first change is the transition from "no
 * measurement yet" to the container's real width, which must land in the first
 * painted frame or the table visibly reflows; every change after it is a
 * user-driven resize, where applying each intermediate frame is exactly what
 * produces the artefact the damping exists to remove.
 *
 * "In the first painted frame" is why the apply runs in a LAYOUT effect. The
 * source publishes its first real measurement from a layout effect of its own,
 * so a passive effect here would let one frame paint against the
 * pre-measurement seed — for the fold fit, a frame of geometry fitted to a
 * container width that does not exist, then a visible snap. Below the seed width
 * that frame is worse than cosmetic: the fit would grow the leading track
 * against a wider-than-real container and push MORE content off screen.
 *
 * Not a general-purpose debounce: it damps a value a layout is DERIVED from, so
 * the layout holds its last settled shape through a continuous change instead of
 * being recomputed per frame. Do not reach for it to throttle an event handler —
 * it re-renders on the settle, which is the wrong shape for that.
 */
export function useSettledValue<T>(value: T, settleMs: number): T {
  const [settled, setSettled] = useState<T>(value);
  // Whether a change has ever been applied. The first one lands immediately (see
  // the doc above); only later ones wait out `settleMs`. Set only on the branch
  // that actually applies a value, never when a timer is merely scheduled, so a
  // cancelled timer cannot consume the leading edge.
  const hasAppliedChangeRef = useRef(false);
  // Whether damping was on for the previous render, so a mid-life transition can
  // be caught below.
  const [wasDamping, setWasDamping] = useState(settleMs > 0);
  const isDamping = settleMs > 0;

  // Damping turning ON mid-life is the normal case for a flag-gated caller: the
  // web gate is a PostHog flag that resolves AFTER mount, by which point
  // `settled` still holds whatever the value was at mount. Switching to it as-is
  // would paint one frame of a stale value — for `GridTable`'s fold fit, a frame
  // of visibly wrong column geometry, which is the whole class of defect this
  // exists to remove. Re-seed from the CURRENT value instead. This is React's
  // adjust-state-during-render pattern: it re-renders immediately, before the
  // browser paints, so no stale frame reaches the screen and no effect is needed.
  if (isDamping !== wasDamping) {
    setWasDamping(isDamping);
    setSettled(value);
    // The re-seeded value counts as applied, so the NEXT change is damped rather
    // than consuming the leading edge — arming mid-resize must not let one more
    // frame straight through.
    hasAppliedChangeRef.current = isDamping;
  }

  // A LAYOUT effect, so the leading-edge apply below is committed before the
  // browser paints (see `useSettleEffect`). The trailing timer branch is
  // unaffected by the phase — a `setTimeout` scheduled here fires exactly as it
  // did from a passive effect — so damping a continuous resize is unchanged.
  useSettleEffect(() => {
    if (settleMs <= 0 || Object.is(settled, value)) {
      return;
    }
    if (!hasAppliedChangeRef.current) {
      hasAppliedChangeRef.current = true;
      setSettled(value);
      return;
    }
    const timer = setTimeout(() => setSettled(value), settleMs);
    // Clears a superseded timer as well as unmount: a change arriving mid-wait
    // re-runs this effect, which cancels the pending apply and restarts the
    // window against the newest value — the trailing half of the debounce.
    return () => clearTimeout(timer);
  }, [value, settleMs, settled]);

  return settleMs > 0 ? settled : value;
}
