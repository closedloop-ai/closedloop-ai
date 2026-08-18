import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS as CANONICAL_SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";

/**
 * Canonical Agent Sessions status-filter contract (single source of truth for
 * every shared surface — Sessions filter menu, monitoring analytics toolbar,
 * and the kanban columns).
 *
 * The wire value is ALWAYS the canonical cross-runtime `SESSION_STATUS` string.
 * Both data sources reconcile that single value at their own boundary:
 *   • cloud HTTP filters `artifact.status` directly (stores "error"), and
 *   • the desktop-local adapter canonicalizes its legacy "error"→"failed" rows
 *     and the requested filter through the same alias map.
 * No surface may send a non-canonical literal (e.g. "failed"), which matched
 * zero rows on the cloud source and split the contract across surfaces.
 *
 * The user-facing label stays "Failed" for the ERROR value to preserve the
 * existing UX vocabulary.
 */
export type SessionStatusFilterOption = {
  value: string;
  label: string;
};

export const SESSION_STATUS_LABELS = CANONICAL_SESSION_STATUS_LABELS;

/**
 * ISS-4696 — the ONE declaration of the Status **facet** vocabulary.
 *
 * ISS-4586 retired `completed`/`abandoned` from the facet: they collapse into
 * `Inactive`, and the server-side facet predicate (`buildStatusFacetPredicate`)
 * expands a selected `inactive` to also match not-yet-migrated `completed`/
 * `abandoned` rows, so the filter still reaches every row the table shows as
 * Inactive. ISS-4605 then shipped the active-filter chip row, which resolves a
 * chip's value label from the facet option list — so a flow or fixture that
 * drives a RETIRED value gets no option, and the chip falls back to rendering
 * the raw wire string (`Status: completed`).
 *
 * The two tickets had drifted apart because the vocabulary was only ever
 * spelled out inside {@link SESSION_STATUS_FILTER_OPTIONS}, leaving every test
 * and flow to hand-pick a `SESSION_STATUS` member and hope it was still a facet
 * option. This const is that missing name: the facet vocabulary declared once,
 * with the option list DERIVED from it, so a value cannot be facet-valid in one
 * place and retired in another.
 *
 * A member here is a promise that the server has a predicate for it. Do not add
 * one for a lane the query cannot filter on — see the `syncing` tripwire in
 * this module's tests.
 *
 * NOT the full status vocabulary: a row may still STORE (and the table may still
 * display) a legacy `completed`/`abandoned` value, and a legacy bookmarked URL
 * may still carry one. Use `SESSION_STATUS` for those; use this for anything
 * that has to resolve a facet option.
 */
export const SessionStatusFacetValue = {
  Active: SESSION_STATUS.ACTIVE,
  /** The awaiting-input sub-state of active. */
  Waiting: DISPLAYED_SESSION_STATUS.WAITING,
  /** Terminal-but-not-failed. Absorbs the retired `completed`/`abandoned`. */
  Inactive: SESSION_STATUS.INACTIVE,
  /** Labelled "Failed" — the display vocabulary keeps the older word. */
  Error: SESSION_STATUS.ERROR,
  /**
   * ISS-5366: an `active` run silent past the display staleness threshold. The
   * Status column has badged these "Stale" for every user since the
   * `sessions-honest-unknown-states` gate was retired, so the facet has to be
   * able to gather them — a value on screen with nothing to click is the defect
   * this vocabulary exists to prevent.
   *
   * The "server has a predicate for it" promise above is kept: the ACTIVE and
   * STALE predicates in `buildStatusFacetPredicate` now PARTITION the old Active
   * population against the same cutoff the badge reads, and
   * `projectDisplayedSessionStatus` serves the folded value, so selecting Stale
   * returns exactly the rows whose badges say Stale.
   */
  Stale: DISPLAYED_SESSION_STATUS.STALE,
  /**
   * ISS-5366: a status the display fold does not recognize (a version-skewed or
   * legacy producer value). Badged "Unknown" rather than fail-open "Active", and
   * reachable via the `NOT IN` predicate over
   * `RECOGNIZED_SESSION_STATUS_VALUES`.
   */
  Unknown: DISPLAYED_SESSION_STATUS.UNKNOWN,
} as const;
export type SessionStatusFacetValue =
  (typeof SessionStatusFacetValue)[keyof typeof SessionStatusFacetValue];

/**
 * The Status facet's options, derived from {@link SessionStatusFacetValue} so
 * the vocabulary has exactly one declaration site, and labelled from the shared
 * {@link SESSION_STATUS_LABELS} so the option text cannot drift from the badge
 * the table renders for the same value.
 */
export const SESSION_STATUS_FILTER_OPTIONS: readonly SessionStatusFilterOption[] =
  Object.values(SessionStatusFacetValue).map((value) => ({
    value,
    label: SESSION_STATUS_LABELS[value],
  }));

/**
 * Is `value` a status the Status facet can actually offer?
 *
 * The narrowing is the point: a caller that guards on this may then resolve a
 * facet option (and therefore a chip label) for the value without a fallback.
 */
export function isSessionStatusFacetValue(
  value: string
): value is SessionStatusFacetValue {
  return (Object.values(SessionStatusFacetValue) as string[]).includes(value);
}

/**
 * De-duplicate a Status-facet selection list read from a URL or a saved view.
 *
 * ISS-5592 removed what this used to FOLD. A bookmarked `?status=completed` was
 * mapped onto the Inactive facet option so the chip read `Status: Inactive`
 * rather than the raw lowercase wire word; with the retired vocabulary gone,
 * `completed` is an ordinary unrecognized value and is returned unchanged — it
 * stays visible and removable rather than being coerced onto a facet value the
 * user never picked, which is how every other unrecognized value already
 * behaved.
 *
 * Kept as a named function rather than inlining the `Set`: the de-duplication is
 * still required (a saved view can list the same value twice), and the call site
 * in `session-filter-adapter.tsx` documents the boundary this crosses.
 */
export function dedupeSessionStatusFacetValues(
  values: readonly string[]
): string[] {
  return [...new Set(values)];
}
