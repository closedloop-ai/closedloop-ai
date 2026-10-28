/**
 * ISS-9622 — the sentence that states what slice of history a token trend
 * actually covers.
 *
 * ISS-6887 made the producer honest: `/agent-components/{slug}/token-trend`
 * applies a default 90-day window and a raw-row ceiling, and now says so on the
 * wire via `appliedWindow` and `truncated`. No client ever read either field, so
 * the web chart rendered a bounded slice with nothing naming the bound — the
 * one-page-as-the-population lie, in its windowed form. This module is what the
 * chart reads them through.
 *
 * The five states stay DISTINGUISHABLE rather than collapsing into one string:
 * a producer that omits `appliedWindow` is UNKNOWN scope, not all-time, so it
 * gets silence — asserting "Last 90 days" against a payload that never said so
 * would trade one confident wrong number for another. Truncation is reported
 * independently of the window, because a read can hit the row ceiling whether or
 * not it also stated its bounds.
 *
 * Phrasing follows `detail-tab-truncation-readout.ts`, the page's existing
 * disclosure voice: no trailing period, sits beside sibling readouts that carry
 * none. "Last 90 days" matches the desktop sibling panel's `({windowDays}d)`
 * caption so the two hosts describe the same bound the same way.
 */

import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { DATE_RANGE_LABELS } from "../../shared/lib/format-utils";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRUNCATED_CLAUSE = "most recent sessions only";
/**
 * The product already names these three windows, and the shipped producer
 * default is 90 days — so the caption must read in exactly the words every
 * other window control uses rather than a second spelling of the same phrase.
 * A window outside the canonical set (only reachable if a future caller sends
 * an explicit `since`/`until`) falls back to the generated form.
 */
const CANONICAL_WINDOW_LABEL_BY_DAYS = new Map<number, string>([
  [7, DATE_RANGE_LABELS["7d"]],
  [30, DATE_RANGE_LABELS["30d"]],
  [90, DATE_RANGE_LABELS["90d"]],
]);

/**
 * "Last 90 days", "Last 90 days · most recent sessions only", or `null` when
 * the payload discloses no bound at all.
 *
 * `nowMs` is injected rather than read from the clock here so the sentence is a
 * pure function of the payload and the caller's instant — `appliedWindow.until`
 * is omitted when the read was unbounded above, and that open end has to resolve
 * against something.
 */
export function tokenTrendWindowReadout(
  data: Pick<TokenTrendResponse, "appliedWindow" | "truncated"> | undefined,
  nowMs: number
): string | null {
  const days = appliedWindowDays(data?.appliedWindow, nowMs);
  const truncated = data?.truncated === true;
  if (days === null) {
    return truncated ? capitalize(TRUNCATED_CLAUSE) : null;
  }
  const window =
    CANONICAL_WINDOW_LABEL_BY_DAYS.get(days) ??
    `Last ${days} ${days === 1 ? "day" : "days"}`;
  return truncated ? `${window} · ${TRUNCATED_CLAUSE}` : window;
}

/**
 * Whole days the read covered, or `null` when the producer stated no window or
 * stated one this client cannot parse. Floors at 1: a sub-day window is still a
 * window, and a `0` would read as "no data" rather than "a short range".
 */
function appliedWindowDays(
  appliedWindow: TokenTrendResponse["appliedWindow"],
  nowMs: number
): number | null {
  if (!appliedWindow) {
    return null;
  }
  const since = Date.parse(appliedWindow.since);
  const until = appliedWindow.until ? Date.parse(appliedWindow.until) : nowMs;
  if (Number.isNaN(since) || Number.isNaN(until) || until < since) {
    return null;
  }
  return Math.max(1, Math.round((until - since) / MS_PER_DAY));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
