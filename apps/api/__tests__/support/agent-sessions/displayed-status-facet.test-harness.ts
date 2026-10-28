import { STALE_SESSION_DISPLAY_THRESHOLD_HOURS } from "@repo/api/src/types/session-status";
import { vi } from "vitest";

/**
 * ISS-4556 / ISS-4559 / ISS-5656: shared session-shape fixtures for the
 * DISPLAY sweep suite (`displayed-status-parity.test.ts`).
 *
 * **ISS-9939 / ISS-10629 (2026-09-17):** this module used to ALSO carry a
 * three-valued SQL interpreter (`evaluateClause` and its helpers) plus
 * `facetMatches`, which drove the Sessions FILTER through `findSessions` and
 * evaluated the emitted Prisma clause against a record — the machinery behind
 * "a row is returned by exactly the Status facet its badge names." That
 * property is RETIRED on cloud: the operator ruling collapsed the Sessions
 * status FILTER to a plain equality against the three PERSISTED
 * SESSION_STATUS values, so FILTER no longer does badge-matching for
 * Waiting/Stale/Unknown, and there is no longer a Prisma clause shape for an
 * interpreter to evaluate (the emitted `where` is now a bare
 * `artifact.is.status` equality/`in`, asserted directly in
 * `query-builder.test.ts` rather than through this interpreter). Deleted with
 * its only two callers rather than left dead. ISS-10629's follow-through then
 * retired the same three arms on DESKTOP, so no surface does badge-matching
 * in a FILTER any more — what this module still serves is the DISPLAY sweep,
 * which is unchanged.
 */

const AWAITING_AT = new Date("2026-01-01T01:30:00.000Z");
const ENDED_AT = new Date("2026-01-01T02:00:00.000Z");

export type ParityRecord = {
  status: string;
  awaitingInputSince: Date | null;
  sessionEndedAt: Date | null;
  lastActivityAt: Date | null;
  sessionStartedAt: Date | null;
};

/**
 * The four dimensions a row's displayed status can turn on. `DisplayedStatusParityCase`
 * satisfies this structurally, so the oracle suite passes its cases straight in.
 */
export type SessionShape = {
  readonly rawStatus: string;
  readonly awaitingInput: boolean;
  readonly ended: boolean;
  readonly staleAnchor: boolean;
};

/**
 * An activity instant OUTSIDE the display staleness window, derived from the
 * shared cutoff so a change to the threshold cannot leave these fixtures on the
 * wrong side of it. Computed per call, never at module load, so a long test run
 * cannot age it into or out of the window.
 */
export function staleAnchorAt(): Date {
  return new Date(
    Date.now() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 1) * 60 * 60 * 1000
  );
}

/** Build the record a session SHAPE describes. */
export function toRecord(shape: SessionShape): ParityRecord {
  const lastActivityAt = shape.staleAnchor ? staleAnchorAt() : new Date();
  return {
    status: shape.rawStatus,
    awaitingInputSince: shape.awaitingInput ? AWAITING_AT : null,
    sessionEndedAt: resolveShapeEndedAt(shape),
    // ISS-4556: the staleness anchor is driven by the shape, not pinned fresh.
    // It decides whether a row DISPLAYS Stale, which is what these sweeps now
    // assert; it used to be the one dimension the ACTIVE and STALE predicates
    // disagreed on, and a table that held every row inside the window was blind
    // by construction to the gap between them. Both instants are RELATIVE to
    // now — a fixed past date would turn every row Stale as wall-clock time
    // passed.
    lastActivityAt,
    sessionStartedAt: shape.staleAnchor ? staleAnchorAt() : new Date(),
  };
}

/** The end instant a shape describes, fixed well before the activity anchor. */
function resolveShapeEndedAt(shape: SessionShape): Date | null {
  return shape.ended ? ENDED_AT : null;
}

/**
 * ISS-4559 (whitlockk review): the instant every parity suite pins its clock to.
 *
 * These are staleness tests, and the root `AGENTS.md` requires expiry/freshness
 * behaviour to pin time with fake timers rather than ride the wall clock. Three
 * separate readings of "now" have to agree for a case to mean what it says —
 * {@link staleAnchorAt}'s subtraction, the fresh anchor `toRecord` stamps, and
 * the cutoff the DISPLAY projection itself computes. On the real
 * clock those are three different instants, milliseconds apart, and a row sitting
 * exactly on the threshold could fall either side of it depending on how the
 * machine was scheduled.
 *
 * A fixed UTC instant, so the arithmetic is identical everywhere and no local
 * offset or DST edge enters into it.
 */
export const PARITY_CLOCK_INSTANT = new Date("2026-06-15T12:00:00.000Z");

/**
 * Freeze the clock at {@link PARITY_CLOCK_INSTANT} for one test.
 *
 * Called from each suite's own `beforeEach` rather than registering a hook here:
 * a support module that silently installs `beforeEach`/`afterEach` on whoever
 * imports it hides ordering from the suite that owns it. Suites pair this with
 * `vi.useRealTimers()` in `afterEach`.
 */
export function freezeParityClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PARITY_CLOCK_INSTANT);
}
