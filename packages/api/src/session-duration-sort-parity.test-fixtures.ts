/**
 * ISS-6270: the SHARED oracle for the Sessions DURATION-SORT contract — one
 * table of session shapes and, for each, the span the Duration CELL renders.
 *
 * It exists for the same reason
 * `agent-session-displayed-status-parity.test-fixtures.ts` does: the contract is
 * implemented THREE times and cannot be implemented once. The cell derives it in
 * the browser/renderer (`agentSessionToSessionTableRow` →
 * `resolveSessionDurationWindow`), the cloud sort derives it in `apps/api`
 * (`resolveDisplayDurationMs`), and the desktop Local sort derives it in the
 * Electron main process (`sessionDurationMs`) — and this repo deliberately does
 * not import across the `apps/api` ↔ `apps/desktop` ↔ browser boundaries, which
 * is why each of those modules restates the rule in its own docstring.
 *
 * WHY IT IS THE CELL'S ANSWER AND NOT A SORT CONSTANT: ISS-5575 routed the
 * Duration CELL through `resolveDisplayedSessionStatus` and left both
 * comparators reading the raw `session.status`, and every duration-sort suite
 * stayed green — because each side asserted its comparator against its own
 * hand-written expected order. A session folded to `stale` rendered an empty
 * cell while its comparator measured a still-growing span from the raw `active`
 * status, so `?sortBy=duration&sortDir=desc` put rows displaying NOTHING at the
 * top of the page. Comparing each implementation independently to a constant is
 * precisely what could not catch that. {@link DurationSortParityCase.displayedSpanMs}
 * is therefore the value the CELL renders, verified against the real mapper by
 * `packages/app/agents/lib/__tests__/session-duration-sort-parity.test.ts`, and
 * the two comparator suites derive their expected ORDER from it rather than
 * restating one.
 *
 * Consumers — ALL of them. Every one builds a fixture row out of these fields,
 * so a field added here is a field each must thread; the web E2E was left off
 * this list and was the one that then dropped `awaitingInputSinceBeforeMs`,
 * serving a shape no case describes:
 *  - `packages/app/agents/lib/__tests__/session-duration-sort-parity.test.ts`
 *    (anchors the oracle to the rendered cell)
 *  - `apps/api/app/agent-sessions/service/duration-sort-displayed-status.test.ts`
 *  - `apps/desktop/test/session-duration-sort-displayed-status.test.ts`
 *  - `e2e/sessions-duration-sort-stale-blank.spec.ts`
 */

import { UNRECOGNIZED_SESSION_STATUS } from "./agent-session-displayed-status-parity.test-fixtures.ts";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "./types/session-status.ts";

/** One hour, in milliseconds — the unit every offset below is expressed in. */
const HOUR_MS = 3_600_000;

export type DurationSortParityCase = {
  /** What the case demonstrates, used as the test name on all three surfaces. */
  readonly name: string;
  /** A stable id, used as the sort fixture's primary key and tiebreaker input. */
  readonly id: string;
  /**
   * The status the row PERSISTS. `string`, not `SessionStatus`, because the
   * version-skew case stores a value outside the union — see
   * {@link UNRECOGNIZED_SESSION_STATUS}. Both comparators read a candidate
   * built from this, which is the point: the defect was reading it DIRECTLY.
   */
  readonly rawStatus: string;
  /**
   * The status spellings a PRODUCER can serve for this shape. More than one
   * where the two producers legitimately differ: the cloud list projection
   * applies the staleness fold server-side (`projectDisplayedSessionStatus`)
   * while the desktop Local producer serves the raw canonical status unless the
   * `sessions-displayed-status-parity` Labs gate is on. The cell must resolve the
   * SAME span from every spelling here — that equality is what makes one oracle
   * legitimate for both surfaces.
   */
  readonly servedStatuses: readonly string[];
  /** How long before `now` the session started. */
  readonly startedBeforeMs: number;
  /**
   * How long before `now` the activity anchor sits. Expressed RELATIVE to now —
   * a hard-coded past literal turns every row stale as the wall clock passes it.
   */
  readonly silentForMs: number;
  /**
   * The session's own end instant as an offset AFTER its start, or `null` when
   * no end instant was ever recorded.
   */
  readonly endedAfterStartMs: number | null;
  /**
   * How long before `now` the row asked for user input, or `null` for a row
   * that never did.
   *
   * REQUIRED rather than optional: `waiting` is exempt from the staleness fold,
   * so this field alone decides whether a long-silent row keeps timing. A case
   * that omitted it would silently take the not-waiting branch, which is the
   * shape that let this population go uncovered in the first place.
   */
  readonly awaitingInputSinceBeforeMs: number | null;
  /**
   * THE ORACLE: the span the Duration CELL renders, or `null` when the cell
   * renders BLANK. A row whose cell is blank must sort with the other blanks —
   * last in BOTH directions (FEA-4330) — never above a row showing a real span.
   */
  readonly displayedSpanMs: number | null;
};

/**
 * The invariant every case encodes: the Duration sort key equals the Duration
 * the cell renders, so a reader can verify the page order from what is on
 * screen.
 */
export const DURATION_SORT_PARITY_CASES: readonly DurationSortParityCase[] = [
  {
    name: "a terminal session measures start -> its own end",
    id: "d-terminal-3h",
    rawStatus: SESSION_STATUS.INACTIVE,
    servedStatuses: [SESSION_STATUS.INACTIVE],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 37 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: 3 * HOUR_MS,
    displayedSpanMs: 3 * HOUR_MS,
  },
  {
    name: "a short terminal session measures its own smaller span",
    id: "d-terminal-30m",
    rawStatus: SESSION_STATUS.INACTIVE,
    servedStatuses: [SESSION_STATUS.INACTIVE],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 39.5 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: 0.5 * HOUR_MS,
    displayedSpanMs: 0.5 * HOUR_MS,
  },
  {
    // The population the fold must NOT touch: a genuinely live run keeps timing
    // against `now`, so a fix that blanked every unended row would red here.
    name: "a live session still inside the staleness window measures start -> now",
    id: "d-running-2h",
    rawStatus: SESSION_STATUS.ACTIVE,
    servedStatuses: [SESSION_STATUS.ACTIVE],
    startedBeforeMs: 2 * HOUR_MS,
    silentForMs: 0,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: null,
    displayedSpanMs: 2 * HOUR_MS,
  },
  {
    // ISS-6270, THE DEFECT: stored `active`, silent past the cutoff, no end
    // instant. The cell folds it to Stale and renders BLANK because the run is
    // not accumulating time; both comparators measured `now - start` off the raw
    // status and made it the LONGEST row on the page.
    name: "a stale-folded session with no end instant renders blank and must not outrank a measured span",
    id: "d-stale-40h",
    rawStatus: SESSION_STATUS.ACTIVE,
    servedStatuses: [SESSION_STATUS.ACTIVE, DISPLAYED_SESSION_STATUS.STALE],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 30 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: null,
    displayedSpanMs: null,
  },
  {
    // The control that keeps the fix honest: folding to Stale must not destroy a
    // span the row's OWN end instant already bounds. A blanket "stale means no
    // duration" would red here.
    name: "a stale-folded session that DID record an end still measures that end",
    id: "d-stale-ended-1h",
    rawStatus: SESSION_STATUS.ACTIVE,
    servedStatuses: [SESSION_STATUS.ACTIVE, DISPLAYED_SESSION_STATUS.STALE],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 30 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: 1 * HOUR_MS,
    displayedSpanMs: 1 * HOUR_MS,
  },
  {
    // Pre-existing (ISS-5131), pinned here so the blanks population is not just
    // the stale one: one instant is not a span.
    name: "a terminal session with no end instant renders blank",
    id: "d-terminal-no-end",
    rawStatus: SESSION_STATUS.INACTIVE,
    servedStatuses: [SESSION_STATUS.INACTIVE],
    startedBeforeMs: 5 * HOUR_MS,
    silentForMs: 4 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: null,
    displayedSpanMs: null,
  },
  {
    // ISS-6270 (wongk, #5111 review): the population `waiting` EXEMPTS from the
    // staleness fold. Stored `active`, asked for approval 30h ago, never ended —
    // silent well past the cutoff, so without the awaiting projection every
    // derivation folds it to Stale and blanks it. The cell does not: the shared
    // renderer resolver projects Waiting ahead of the fold (ISS-6455, ungated on
    // both surfaces) and `resolveSessionDurationLifecycle(waiting)` is Running,
    // so the row keeps timing and shows the longest span in this table.
    //
    // It is the ONLY case whose span depends on `awaitingInputSinceBeforeMs`,
    // which is what makes the field falsifiable at all: with every case pinned
    // to `null`, a comparator that ignored the field entirely stayed green.
    name: "a session awaiting input past the staleness cutoff keeps timing",
    id: "d-awaiting-40h",
    rawStatus: SESSION_STATUS.ACTIVE,
    // The desktop Local producer serves the raw `active` with the
    // `sessions-displayed-status-parity` Labs gate off and `waiting` with it on;
    // the cloud list projection serves `waiting` unconditionally. The cell must
    // resolve the same 40h span from either spelling.
    servedStatuses: [SESSION_STATUS.ACTIVE, DISPLAYED_SESSION_STATUS.WAITING],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 30 * HOUR_MS,
    awaitingInputSinceBeforeMs: 30 * HOUR_MS,
    endedAfterStartMs: null,
    displayedSpanMs: 40 * HOUR_MS,
  },
  {
    // Version skew: a status neither build recognizes never reaches the clock.
    name: "an unrecognized status with no end instant renders blank",
    id: "d-unknown-no-end",
    rawStatus: UNRECOGNIZED_SESSION_STATUS,
    servedStatuses: [UNRECOGNIZED_SESSION_STATUS],
    startedBeforeMs: 6 * HOUR_MS,
    silentForMs: 1 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: null,
    displayedSpanMs: null,
  },
];

/**
 * The id order the Duration column must produce for the whole case set, derived
 * from {@link DurationSortParityCase.displayedSpanMs} — the CELL's answer — so a
 * comparator suite never restates an expected order of its own.
 *
 * Blank rows collect LAST in BOTH directions (FEA-4330), and ties fall to the
 * `id` tiebreaker each surface already applies.
 */
export function expectedDurationSortIds(
  dir: "asc" | "desc",
  tiebreak: (a: DurationSortParityCase, b: DurationSortParityCase) => number
): string[] {
  return [...DURATION_SORT_PARITY_CASES]
    .sort((a, b) => {
      const aBlank = a.displayedSpanMs === null;
      const bBlank = b.displayedSpanMs === null;
      if (aBlank !== bBlank) {
        return aBlank ? 1 : -1;
      }
      if (a.displayedSpanMs !== null && b.displayedSpanMs !== null) {
        const delta = a.displayedSpanMs - b.displayedSpanMs;
        if (delta !== 0) {
          return dir === "asc" ? delta : -delta;
        }
      }
      return tiebreak(a, b);
    })
    .map((c) => c.id);
}
