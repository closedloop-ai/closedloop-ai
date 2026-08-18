/**
 * @file freshness.ts
 * @description When a session-limit snapshot stops being presentable as
 * "current" (PRD-538 R6). This is the DISPLAY policy, and it is deliberately
 * separate from the desktop main process's hard cutoff:
 *
 *  - The main-process snapshot store drops a snapshot entirely once every
 *    sample is past its own staleness horizon, so the renderer never receives
 *    an ancient one.
 *  - Everything the renderer *does* receive still has an age, and a snapshot
 *    older than one refresh cycle is no longer current. Rendering it with no
 *    caveat is the "UI lies about its data" failure this ticket exists to
 *    prevent: the number is real, but it is a number from the past.
 *
 * So the two thresholds are different concepts, not a copied constant — one
 * decides whether to serve a snapshot at all, this one decides whether to
 * caveat the snapshot that was served.
 */

import { formatStaleAsOfLabel, toDateTimeAttribute } from "./format";

/**
 * A snapshot older than this is presented "as of" its capture time rather than
 * as the current figure. The desktop renderer polls at a fraction of this (see
 * `use-session-limits.ts`), so a healthy app refreshes before it can cross the
 * line and a stale label always means something actually stopped updating.
 */
export const SESSION_LIMIT_STALE_DISPLAY_AFTER_MS = 5 * 60 * 1000;

/**
 * True when `fetchedAt` is old enough that the snapshot must be labeled with
 * its capture time instead of shown as current.
 *
 * A missing or unparseable timestamp returns false: with no capture time there
 * is nothing to date the figures to, so claiming staleness would be as much of
 * an invention as claiming freshness. A future timestamp (clock skew) is a
 * negative age and is likewise not stale.
 */
export function isSessionLimitSnapshotStale(
  fetchedAt: string | null | undefined,
  now: Date = new Date(),
  staleAfterMs: number = SESSION_LIMIT_STALE_DISPLAY_AFTER_MS
): boolean {
  if (!fetchedAt) {
    return false;
  }
  const fetchedMs = new Date(fetchedAt).getTime();
  if (Number.isNaN(fetchedMs)) {
    return false;
  }
  return now.getTime() - fetchedMs > staleAfterMs;
}

export type SessionLimitStaleCaveat = {
  /** Human-readable capture time, e.g. "As of Jul 19, 11:20 AM". */
  label: string;
  /** The same instant as a machine-readable `datetime` attribute value. */
  dateTime: string;
};

/**
 * The stale caveat, or null when the snapshot needs none.
 *
 * One selector rather than two, because the caveat has to reach two renderings
 * of the same footer: the visible `<time>` element, and the trigger button's
 * accessible name. An `aria-label` on a button REPLACES its subtree for name
 * computation, so the visible caveat sitting inside that button is not spoken —
 * the name has to state it separately, and if the two derived it independently
 * they could disagree about whether the figures are current. That is the exact
 * failure this whole slice exists to prevent, so the decision is made once here
 * and both callers consume the result.
 *
 * Returns null unless the snapshot is stale AND both renderings are available:
 * dating figures to a timestamp we could not parse would be its own invention.
 */
export function selectSessionLimitStaleCaveat(
  fetchedAt: string | null | undefined,
  now: Date | undefined,
  timeZone: string | undefined
): SessionLimitStaleCaveat | null {
  if (!isSessionLimitSnapshotStale(fetchedAt, now)) {
    return null;
  }
  const label = formatStaleAsOfLabel(fetchedAt, timeZone);
  const dateTime = toDateTimeAttribute(fetchedAt);
  if (!(label && dateTime)) {
    return null;
  }
  return { label, dateTime };
}
