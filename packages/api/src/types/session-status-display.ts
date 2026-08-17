/**
 * @file session-status-display.ts
 * @description The user-facing COPY for the session-status vocabularies — the
 * labels and the two explanatory sentences. Split out of `./session-status.ts`
 * by ISS-5592 so a bundle-sensitive `"use client"` surface that renders a badge
 * can import three strings without pulling in the folds, the normalizers, and
 * the staleness derivation.
 *
 * The only import is the sibling values module, which is dependency-free — no
 * parser, no validator, no zod. That is the property that matters here: this
 * module must stay reachable from a client bundle without dragging one in.
 *
 * The VALUES, the folds, and `STALE_SESSION_DISPLAY_THRESHOLD_HOURS` live next
 * door in `./session-status.ts`. Which vocabulary a value belongs to, and why
 * there are two, is documented in that file's header.
 */
import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "./session-status.ts";

/**
 * Canonical user-facing labels for {@link SESSION_STATUS}. The values live next
 * to the wire contract so non-React runtimes, including desktop E2E tests, can
 * assert rendered labels without re-encoding the vocabulary.
 */
export const SESSION_STATUS_LABELS: Record<DisplayedSessionStatus, string> = {
  [SESSION_STATUS.ACTIVE]: "Active",
  [SESSION_STATUS.INACTIVE]: "Inactive",
  [SESSION_STATUS.ERROR]: "Failed",
  // Legacy labels (ISS-4586) — retained until the values are removed.
  [DISPLAYED_SESSION_STATUS.WAITING]: "Waiting",
  // ISS-4997: reads as the absence of a claim, not as an outcome.
  [DISPLAYED_SESSION_STATUS.UNKNOWN]: "Unknown",
  // ISS-4998: a fact about the SESSION ("it has gone quiet"), where "Unknown" is
  // a fact about US ("we cannot read this value"). One word per fact (#4324).
  [DISPLAYED_SESSION_STATUS.STALE]: "Stale",
};

/**
 * ISS-4997: why an unrecognized status reads "Unknown". Names OUR limitation
 * rather than implying anything about the run, because that is all we know.
 *
 * ISS-4654: hoisted beside {@link SESSION_STATUS_LABELS} because the word and
 * its explanation are one piece of copy and MORE THAN ONE surface renders it.
 * The Sessions LIST badge (`session-status-badges`) and the session-DETAIL
 * Status row (`detail/session-status-display`) both read it from here, so a
 * version-skewed session cannot read explained-unknown on one screen and
 * unexplained-unknown on the other. Consumers compose the accessible name as
 * `${label}, ${tooltip}` — leading with the visible word (WCAG 2.5.3 Label in
 * Name) — because the tooltip itself is hover-only.
 */
export const SESSION_UNKNOWN_TOOLTIP =
  "This app version does not recognize this session's status. The run may still be in progress.";

/**
 * ISS-5575: the canonical sentence explaining the STALE fold, promoted here from
 * `session-status-badges.tsx` where it was a private const.
 *
 * It belongs beside {@link SESSION_UNKNOWN_TOOLTIP} for the same reason that one
 * does: the fold is now stated on more than one surface — the list pill, and the
 * session-detail Duration, which stops measuring the very run this sentence
 * describes — and a reader must not get the explanation on one surface and
 * silence, or a different sentence, on another.
 *
 * Reading {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS} rather than restating
 * "24" is the point: the number in the copy cannot drift from the cutoff that
 * produced the fold.
 */
export const SESSION_STALE_TOOLTIP = `No activity for over ${STALE_SESSION_DISPLAY_THRESHOLD_HOURS} hours, so this session is no longer reporting as running. It has not been observed to end.`;
