// Cross-slice, onboarding -> insights (packages/app/AGENTS.md asks for the why
// at the import site): the anchor vocabulary is owned by the dashboard that
// EMITS the `data-tour` attributes, so the tour reads the emitter's type rather
// than restating it and letting the two drift. Type-only, and the narrowest
// surface that closes the contract.
import type { DashboardTourAnchor } from "../../../insights/components/overview/dashboard-tour-anchors";

/**
 * One beat of the tour: a dashboard section to ring, and what to say about it.
 *
 * EVERY step is anchored. ISS-10546 retired the opening summary card Desktop
 * prepended to its run — the normative prototype
 * (`packages/app/shell/v2/components/web-master-preview/components/dashboard-spotlight-tour.tsx`)
 * opens on the first spotlight, so the `intro` variant this union used to carry
 * had no producer left and went with it.
 */
export type TourStep = {
  /**
   * `data-tour` anchor key on the element to spotlight.
   *
   * Typed to the shared anchor vocabulary, not `string`: a step naming a key
   * no shell emits resolves to nothing at `querySelector` and drops that
   * step at runtime with no error and no failing render. The type closes the
   * READING half of that contract; `ROW_TOUR_ANCHORS` closes the emitting
   * half. A valid anchor that is merely not on screen right now (a gated or
   * data-absent row) is a different case, and the scrim fallback in
   * `dashboard-tour.tsx` handles it.
   */
  sel: DashboardTourAnchor;
  eyebrow?: string;
  title: string;
  body: string;
};

/**
 * A step that rings a dashboard section.
 *
 * An alias of {@link TourStep} since ISS-10546 removed the only other member of
 * that union. Kept as the name the canonical step list and the resolver are
 * typed with, because that is what those two are actually saying about
 * themselves — collapsing them onto `TourStep` would read as "any step" and
 * silently admit a non-anchored one if the union ever grows a second member
 * again.
 */
export type TourAnchoredStep = TourStep;

/**
 * Why a tour run ended.
 *
 * `empty` is not a third way for a READER to leave — it is the run reporting
 * that it never had anything to show. A host and the engine measure the page
 * one commit apart, so they can disagree; when they do, the frozen run is empty,
 * nothing renders, and no control exists for the reader to press. Saying so is
 * what lets a host release whatever it tied to the run without recording a tour
 * the reader was never shown.
 */
export const TourCloseReason = {
  /** The reader walked to the last beat and pressed the completion control. */
  Done: "done",
  /** The reader left early — Skip, Escape, or the blocker. */
  Skip: "skip",
  /** The frozen run had no steps, so nothing was ever painted. */
  Empty: "empty",
} as const;
export type TourCloseReason =
  (typeof TourCloseReason)[keyof typeof TourCloseReason];
