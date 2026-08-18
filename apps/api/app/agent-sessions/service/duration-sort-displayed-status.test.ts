import {
  DURATION_SORT_PARITY_CASES,
  type DurationSortParityCase,
  expectedDurationSortIds,
} from "@repo/api/src/session-duration-sort-parity.test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareByDisplayDuration,
  type DisplaySortCandidate,
} from "./session-display-sort";

/**
 * ISS-6270: the cloud Duration comparator must key on the status the row
 * DISPLAYS, not on the raw persisted column.
 *
 * ISS-5575 routed the Duration CELL through `resolveDisplayedSessionStatus` and
 * left this comparator reading `candidate.artifact.status`. A run silent past the
 * staleness cutoff renders an EMPTY Duration cell — correctly, it is not
 * accumulating time — while the comparator measured `now - start` off the raw
 * `active` status and made it the longest span in the table. Sorted by Duration
 * descending, the top of the page was occupied by rows displaying nothing.
 *
 * The expected order is NOT written here. It is derived from
 * `DURATION_SORT_PARITY_CASES.displayedSpanMs` — the span the real
 * `agentSessionToSessionTableRow` renders, pinned by
 * `packages/app/agents/lib/__tests__/session-duration-sort-parity.test.ts` — so
 * this suite cannot go green while the comparator and the cell disagree. That
 * independence is exactly what the previous per-file constants did not have.
 */

const NOW = new Date("2026-08-14T12:00:00.000Z");

/**
 * The record-mutation anchor every candidate shares, so `Updated` recency can
 * never leak in and satisfy a Duration assertion.
 */
const RECORD_UPDATED_BASE = new Date("2026-05-20T17:00:00.000Z");

function candidate(testCase: DurationSortParityCase): DisplaySortCandidate {
  const sessionStartedAt = new Date(NOW.getTime() - testCase.startedBeforeMs);
  return {
    artifactId: testCase.id,
    sessionStartedAt,
    sessionEndedAt:
      testCase.endedAfterStartMs === null
        ? null
        : new Date(sessionStartedAt.getTime() + testCase.endedAfterStartMs),
    awaitingInputSince:
      testCase.awaitingInputSinceBeforeMs === null
        ? null
        : new Date(NOW.getTime() - testCase.awaitingInputSinceBeforeMs),
    lastActivityAt: new Date(NOW.getTime() - testCase.silentForMs),
    updatedAt: RECORD_UPDATED_BASE,
    artifact: { status: testCase.rawStatus, updatedAt: RECORD_UPDATED_BASE },
    user: null,
  };
}

/**
 * FEA-4329: this comparator breaks ties on `artifactId` DESCENDING, so the
 * oracle's order is resolved with that same tiebreak rather than a second
 * expectation about it.
 */
function tiebreakByIdDesc(
  a: DurationSortParityCase,
  b: DurationSortParityCase
): number {
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
}

function sortedIds(dir: "asc" | "desc"): string[] {
  return DURATION_SORT_PARITY_CASES.map(candidate)
    .sort((a, b) => compareByDisplayDuration(a, b, dir))
    .map((c) => c.artifactId);
}

describe("compareByDisplayDuration orders by the DISPLAYED duration (ISS-6270)", () => {
  beforeEach(() => {
    // Every case's staleness anchor and running span are expressed relative to
    // `NOW`, and the comparator reads the real clock. Pinning it makes the whole
    // ordering exact rather than approximately right for the next few hours.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("descending: no row whose Duration cell is BLANK outranks a measured span", () => {
    expect(sortedIds("desc")).toEqual(
      expectedDurationSortIds("desc", tiebreakByIdDesc)
    );
  });

  it("ascending: blanks still collect LAST (FEA-4330), they do not lead the page", () => {
    expect(sortedIds("asc")).toEqual(
      expectedDurationSortIds("asc", tiebreakByIdDesc)
    );
  });

  it("leads a Duration-descending page with the LONGEST displayed span", () => {
    // The reader-facing statement of the defect: descending by Duration used to
    // lead with a row whose cell shows nothing.
    //
    // Asserting only "the leader is not blank" is NOT enough, and this case is
    // the proof — it passed against the unfixed comparator, because the row that
    // led was a stale row that happened to carry an `endedAt` and so had a
    // non-null displayed span even while its KEY was a phantom 40h. The leader
    // has to be the actual maximum.
    const longest = DURATION_SORT_PARITY_CASES.reduce((best, current) =>
      (current.displayedSpanMs ?? -1) > (best.displayedSpanMs ?? -1)
        ? current
        : best
    );
    expect(sortedIds("desc")[0]).toBe(longest.id);
  });

  it("keeps the stale-folded row from outranking every measured row", () => {
    // Named separately from the whole-order assertions so the failure message
    // points at the population, not at a 7-element array diff.
    const order = sortedIds("desc");
    const stalePosition = order.indexOf("d-stale-40h");
    const measuredPositions = DURATION_SORT_PARITY_CASES.filter(
      (c) => c.displayedSpanMs !== null
    ).map((c) => order.indexOf(c.id));
    for (const measured of measuredPositions) {
      expect(stalePosition).toBeGreaterThan(measured);
    }
  });
});
