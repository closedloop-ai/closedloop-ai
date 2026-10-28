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
import { SESSION_STATUS } from "./types/session-status.ts";

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
   * where a producer can legitimately serve either: the cloud list applies the
   * staleness fold server-side (`projectDisplayedSessionStatus`), while a
   * version-skewed producer can still serve the raw canonical status. The cell
   * must resolve the SAME span from every spelling here — that equality is what
   * makes one oracle legitimate for both surfaces.
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
    // ISS-6270's defect row, re-pointed by ISS-10364. Stored `active`, silent
    // 30h, no end instant. It used to fold to Stale and render BLANK; the
    // operator ruled on 2026-09-23 that active and stale are not to be
    // distinguished, so the row IS active and a run with no recorded end
    // accumulates time. Kept — with the silence that used to matter — so that a
    // future change quietly restoring a cutoff has to edit this span.
    name: "ISS-10364: a long-silent session with no end instant keeps timing",
    id: "d-stale-40h",
    rawStatus: SESSION_STATUS.ACTIVE,
    // "stale" is a plain literal, not a vocabulary member: ISS-10364 retired it
    // from `DISPLAYED_SESSION_STATUS`, so this spells the legacy/version-skewed
    // spelling a producer predating that ruling can still serve.
    servedStatuses: [SESSION_STATUS.ACTIVE, "stale"],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 30 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: null,
    displayedSpanMs: 40 * HOUR_MS,
  },
  {
    // A stored `active` row keeps timing against `now` whether or not it
    // carries a recorded end, so the 1h end instant here must NOT bound the
    // span. Third of three rows tying at 40h (with `d-stale-40h` and
    // `d-awaiting-40h`), which is what makes the shared id tiebreak reachable.
    name: "an ended active row is not bounded by its own end — it keeps timing",
    id: "d-stale-ended-1h",
    rawStatus: SESSION_STATUS.ACTIVE,
    servedStatuses: [SESSION_STATUS.ACTIVE],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 39 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: 1 * HOUR_MS,
    displayedSpanMs: 40 * HOUR_MS,
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
    // ISS-6270 (whitlockk, #5111 review): the population `waiting` EXEMPTS from the
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
    // Both producers serve `waiting` today — cloud through
    // `projectDisplayedSessionStatus`, desktop Local since ISS-7019 — and a
    // version-skewed one can still serve the raw `active`. The cell must
    // resolve the same 40h span from either spelling.
    // "waiting" is a plain literal too, for the same reason as the "stale" case
    // above — it is no longer a `DISPLAYED_SESSION_STATUS` member.
    servedStatuses: [SESSION_STATUS.ACTIVE, "waiting"],
    startedBeforeMs: 40 * HOUR_MS,
    silentForMs: 30 * HOUR_MS,
    awaitingInputSinceBeforeMs: 30 * HOUR_MS,
    endedAfterStartMs: null,
    displayedSpanMs: 40 * HOUR_MS,
  },
  {
    // Version skew, re-pointed by ISS-10364: a status neither build recognizes
    // used to answer the display-only `unknown`, an Indeterminate lifecycle that
    // never reached the clock. It now fails OPEN to `active` like any other
    // unreadable spelling, so it times like one. Kept as the counterfactual.
    name: "ISS-10364: an unrecognized status with no end instant keeps timing",
    id: "d-unknown-no-end",
    rawStatus: UNRECOGNIZED_SESSION_STATUS,
    servedStatuses: [UNRECOGNIZED_SESSION_STATUS],
    startedBeforeMs: 6 * HOUR_MS,
    silentForMs: 1 * HOUR_MS,
    awaitingInputSinceBeforeMs: null,
    endedAfterStartMs: null,
    displayedSpanMs: 6 * HOUR_MS,
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
