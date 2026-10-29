/**
 * @file preview-trace-scrubber-drag.ts
 * @description What a drag across the axis strip MEANS, kept away from the DOM.
 *
 * The strip has one gesture and two readings of it, and which one a press picks
 * is decided by where the press landed relative to the window already drawn:
 * outside it, the drag cuts a new window; inside it, the drag moves the one the
 * highlight is inviting the reader to grab. Treating every press as a fresh
 * selection made the second gesture resize the window instead of panning it,
 * which is the opposite of what the drag looked like.
 *
 * Fractions of the whole session throughout, never milliseconds: the strip is
 * always the full extent, so a fraction is the only coordinate both the pointer
 * and the highlight agree on.
 */

/**
 * `select` cuts a NEW window between two fractions. `pan` slides the EXISTING
 * one and keeps the press it started from — where on the axis it landed and the
 * window as it was THEN — so every frame is measured from the press rather than
 * from the previous frame, which would compound and run away from the cursor.
 */
export type ScrubberDrag =
  | { mode: "select"; from: number; to: number }
  | {
      mode: "pan";
      grabbedAt: number;
      grabbedFrom: number;
      grabbedTo: number;
      from: number;
      to: number;
    };

export type ScrubberWindow = {
  windowFrom: number;
  windowTo: number;
  /**
   * False when the window covers the whole session. Such a window has no inside
   * to grab — every press would pan a strip that cannot move, and the control's
   * only gesture would stop cutting windows at all.
   */
  isWindowed: boolean;
};

/** Which of the two gestures a press at `at` started. */
export function beginScrubberDrag(
  at: number,
  { windowFrom, windowTo, isWindowed }: ScrubberWindow
): ScrubberDrag {
  if (isWindowed && at > windowFrom && at < windowTo) {
    return {
      mode: "pan",
      grabbedAt: at,
      grabbedFrom: windowFrom,
      grabbedTo: windowTo,
      from: windowFrom,
      to: windowTo,
    };
  }
  return { mode: "select", from: at, to: at };
}

/** Where a drag sits once the pointer has reached `at`. */
export function advanceScrubberDrag(
  drag: ScrubberDrag,
  at: number
): ScrubberDrag {
  if (drag.mode === "select") {
    return { mode: "select", from: drag.from, to: at };
  }
  const width = drag.grabbedTo - drag.grabbedFrom;
  // The OFFSET is clamped, not each edge: clamping the edges independently
  // squashes the window against the end of the axis instead of stopping it.
  const offset = Math.min(
    1 - drag.grabbedTo,
    Math.max(-drag.grabbedFrom, at - drag.grabbedAt)
  );
  return {
    ...drag,
    from: drag.grabbedFrom + offset,
    to: drag.grabbedFrom + offset + width,
  };
}
