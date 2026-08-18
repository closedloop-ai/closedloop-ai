/**
 * ISS-5464 — the ONE truncation readout shape for the component detail page.
 *
 * The detail page renders three bounded tables (Sessions, Branches, Evidence)
 * and before this module each printed its own sentence: Sessions said
 * "Showing 50 of 1218 sessions." with an unformatted total and a trailing
 * period, Branches said "Showing 50 of 50 branches (most recently active)" off a
 * capped array length, and Evidence said "Showing 50 of 1218" above its table at
 * `text-xs` with no unit noun. Three shapes, one page, one click apart — and the
 * Sessions list the user came from says "Showing 1-25 of 1,218 sessions". This
 * module is the single place that decides how a bounded table states what it is
 * showing, so the page can only ever speak in one voice.
 *
 * The phrasing follows the repo's existing footer sentences (`sessionsRangeReadout`,
 * `resolveMyTasksRangeReadout`): `formatNumber` for every number, the unit noun
 * always present and pluralised, and NO trailing period — these sit beside
 * sibling readouts that carry none, and `TablePaginationFooter` announces the
 * same shape through a `role="status"` live region.
 *
 * A total that is only a FLOOR is marked `+`, the convention readers already
 * parse from Gmail and GitHub, and the one `resolveMyTasksTruncation` established
 * here. That marker replaces the previous "Showing 50 sessions; total
 * unavailable." — which read like a status code, used a semicolon to do a
 * period's work, and named the missing FIELD rather than the meaning. "Showing
 * 50 of 50+ sessions" says the same thing in the reader's vocabulary and, unlike
 * the old string, stays true on a surface whose producer applied no cap at all.
 */

import { formatNumber } from "../../shared/lib/format-utils";

/**
 * What a bounded detail tab is counting. The singular/plural pair is carried
 * together so a caller can never pluralise one of them wrongly.
 */
export const DetailTabUnit = {
  Sessions: { one: "session", many: "sessions" },
  Branches: { one: "branch", many: "branches" },
  Invocations: { one: "invocation", many: "invocations" },
} as const;
export type DetailTabUnit = (typeof DetailTabUnit)[keyof typeof DetailTabUnit];

/**
 * "Showing 50 of 1,218 sessions", or `null` when the table is showing
 * everything there is and has nothing to disclose.
 *
 * `rendered` is the row count actually mounted — never the arithmetic bound, and
 * never the delivered array length, both of which can claim rows the reader
 * cannot see.
 *
 * `total` is the honest population. When `isTotalPartial` it is a floor (the
 * producer's payload was bounded, or the true count is unknowable from here) and
 * is marked `+`. A floor EQUAL to `rendered` still prints — "Showing 50 of 50+
 * sessions" is the disclosure that there may be more, and silence in that state
 * would imply completeness, which is the lie this module exists to stop. A
 * complete total equal to `rendered` prints nothing, because there is nothing to
 * disclose.
 */
export function detailTabTruncationReadout({
  rendered,
  total,
  isTotalPartial,
  unit,
}: {
  rendered: number;
  total: number;
  isTotalPartial: boolean;
  unit: DetailTabUnit;
}): string | null {
  if (!isTotalPartial && total <= rendered) {
    return null;
  }
  const noun = total === 1 && !isTotalPartial ? unit.one : unit.many;
  const totalLabel = isTotalPartial
    ? `${formatNumber(total)}+`
    : formatNumber(total);
  return `Showing ${formatNumber(rendered)} of ${totalLabel} ${noun}`;
}
