"use client";

import type { DashboardTourAnchor } from "../../../insights/components/overview/dashboard-tour-anchors";
import { measureRect, spotlightHole } from "./dashboard-tour-geometry";
import {
  DASHBOARD_TOUR_STEPS,
  REDUCED_DASHBOARD_TOUR_STEPS_DESKTOP_DOWNLOAD,
} from "./dashboard-tour-steps";
import type { TourAnchoredStep, TourStep } from "./dashboard-tour-types";

/**
 * Whether a dashboard anchor is a usable spotlight target right now.
 *
 * Usable means MEASURABLE, not merely present in the document. An element that
 * exists but measures zero area — a `display: none` row, a section collapsed to
 * nothing, a node already detached — gets no hole from `spotlightHole` and
 * renders as a full-dim scrim with a docked callout. Counting it as present
 * would hand that step a progress dot and a step number for a section the
 * reader is never actually shown: the same lie as the all-zero rect the
 * geometry already refuses, moved one layer up into the run list.
 *
 * The area rule is not restated here — it is READ from `spotlightHole`, so the
 * resolver and the ring can never disagree about the RULE; change it there and
 * this follows. They can still disagree about the ANSWER, because the agreement
 * is per-reading and not durable: this samples once at activation while the ring
 * re-measures on scroll and resize, so an anchor that loses its area mid-run
 * keeps the dot it was given and falls back to the ring's full-dim scrim.
 */
export function isDashboardTourAnchorPresent(
  anchor: DashboardTourAnchor
): boolean {
  const element = globalThis.document.querySelector<HTMLElement>(
    `[data-tour="${anchor}"]`
  );
  if (!element) {
    return false;
  }
  return spotlightHole(measureRect(element)) !== null;
}

/**
 * The run list for one tour: the surface's own leading steps, then the
 * canonical anchored steps whose targets are on the page.
 *
 * Called ONCE per run, by `Tour`, on the render that opens it — a surface hands
 * the engine a resolver, not a list, so the moment is not the surface's to get
 * wrong. That freeze is what makes activation the only consistent moment to
 * resolve: a list rebuilt mid-run leaves `idx` past the new end, so the tour
 * vanishes without ever calling `onClose` and the tour-seen flag never writes.
 *
 * Resolving up front rather than skipping at render is the whole point of this
 * function. Four of the eight dashboard rows can be absent for an ordinary org
 * (`agent-pipeline` is closed by default, `frustration` is opt-in, `activity`
 * and `autonomy` drop when their section resolves empty), so a fixed six-step
 * list renders a progress dot row that lies about how far along the reader is,
 * and can ring the same rectangle three times once `activity` drops and
 * `recentSessionsAnchor` falls back to `stats`.
 *
 * EVERY step in the result is anchored. ISS-10546 removed the `leadingSteps`
 * hook, whose only caller was Desktop's intro summary card — the normative
 * prototype opens on the first spotlight, so that card is gone and nothing
 * prepends to a run any more. An empty result means there is nothing anchored
 * worth showing. A host that activates the tour anyway and gets nothing back is
 * refused by `Tour` outside production; in production that run reports itself
 * over with the `empty` close reason, because it renders nothing and offers the
 * reader no control to end it with.
 */
export function resolveDashboardTourSteps({
  isAnchorPresent = isDashboardTourAnchorPresent,
}: {
  /**
   * Defaults to {@link isDashboardTourAnchorPresent}. A surface that supplies
   * its own must keep the measurable-not-merely-present rule, or it puts back
   * the lit-empty-step this resolver exists to remove.
   */
  isAnchorPresent?: (anchor: DashboardTourAnchor) => boolean;
} = {}): TourStep[] {
  return measureAnchoredSteps(DASHBOARD_TOUR_STEPS, isAnchorPresent);
}

/**
 * The run for a dashboard that drew its empty branch instead of its rows
 * (ISS-9727): {@link REDUCED_DASHBOARD_TOUR_STEPS_DESKTOP_DOWNLOAD}, measured the
 * same way.
 *
 * MEASURED RATHER THAN RETURNED WHOLE, which is the half that matters. The
 * anchor lives on the empty state, so it exists only on the commit where that
 * branch is what rendered; the host arms off the dashboard's own report of its
 * content state, and the two are read one commit apart. An empty result is the
 * honest answer when they disagree, and it is what lets the host fall back to
 * the deferral ISS-8351 guarantees rather than opening a scrim over rows.
 */
export function resolveReducedDesktopDownloadDashboardTourSteps({
  isAnchorPresent = isDashboardTourAnchorPresent,
}: {
  isAnchorPresent?: (anchor: DashboardTourAnchor) => boolean;
} = {}): TourStep[] {
  return measureAnchoredSteps(
    REDUCED_DASHBOARD_TOUR_STEPS_DESKTOP_DOWNLOAD,
    isAnchorPresent
  );
}

/** Drop the steps whose anchors this page cannot spotlight, keeping the rest. */
function measureAnchoredSteps(
  steps: readonly TourAnchoredStep[],
  isAnchorPresent: (anchor: DashboardTourAnchor) => boolean
): TourStep[] {
  return steps.filter((step) => isAnchorPresent(step.sel));
}
