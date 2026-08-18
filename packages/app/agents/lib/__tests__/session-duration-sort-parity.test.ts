import {
  DURATION_SORT_PARITY_CASES,
  type DurationSortParityCase,
} from "@repo/api/src/session-duration-sort-parity.test-fixtures";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { agentSessionToSessionTableRow } from "@repo/app/agents/lib/session-table-row";
import { formatDuration } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";

/**
 * ISS-6270: this file is what makes `DURATION_SORT_PARITY_CASES` an ORACLE
 * rather than a third hand-written constant.
 *
 * The two comparator suites (`apps/api`, `apps/desktop`) derive their expected
 * ORDER from `displayedSpanMs`, and neither of them can reach the browser mapper
 * that actually renders the cell. This one can, so it pins every case's
 * `displayedSpanMs` against the real `agentSessionToSessionTableRow` output — the
 * production path behind the Duration cell on BOTH Sessions surfaces. If a case
 * ever claims a span the cell does not render, the sort suites are asserting
 * against a fiction and this test reds first.
 *
 * Each case is checked against EVERY spelling a producer can serve for that
 * shape (`servedStatuses`), because the cloud folds staleness server-side while
 * the desktop Local producer serves the raw canonical status with the
 * `sessions-displayed-status-parity` Labs gate off. The cell must answer
 * identically for both, or the two surfaces do not share one oracle.
 */

const NOW = new Date("2026-08-14T12:00:00.000Z");

/**
 * Built through the package's canonical list-item factory — the same one the
 * sibling `session-table-row.test.ts` uses on this very mapper — rather than a
 * cast object literal. This file is the ANCHOR that makes the shared oracle an
 * oracle, so it is exactly the wrong place to switch type checking off: a cast
 * would keep it green after a rename or a newly-required field while the two
 * comparator suites went on asserting against a shape the list can no longer
 * produce (bug_hunter_a, this PR's review).
 */
function listItem(
  testCase: DurationSortParityCase,
  servedStatus: string
): AgentSessionListItem {
  const startedAt = new Date(NOW.getTime() - testCase.startedBeforeMs);
  return createAgentSessionListItemFixture({
    id: testCase.id,
    status: servedStatus,
    startedAt,
    lastActivityAt: new Date(NOW.getTime() - testCase.silentForMs),
    endedAt:
      testCase.endedAfterStartMs === null
        ? null
        : new Date(startedAt.getTime() + testCase.endedAfterStartMs),
    awaitingInputSince:
      testCase.awaitingInputSinceBeforeMs === null
        ? null
        : new Date(NOW.getTime() - testCase.awaitingInputSinceBeforeMs),
  });
}

/**
 * The label the cell renders for a span, derived through the SAME formatter the
 * mapper uses, so this expectation states the SPAN and never a hand-typed
 * duration string.
 */
function expectedLabel(spanMs: number): string {
  return formatDuration(new Date(0), new Date(spanMs));
}

describe("DURATION_SORT_PARITY_CASES is the Duration cell's own answer (ISS-6270)", () => {
  for (const testCase of DURATION_SORT_PARITY_CASES) {
    for (const servedStatus of testCase.servedStatuses) {
      it(`${testCase.name} (served as "${servedStatus}")`, () => {
        const row = agentSessionToSessionTableRow(
          listItem(testCase, servedStatus),
          null,
          { now: NOW }
        );
        if (testCase.displayedSpanMs === null) {
          expect(row.durationLabel).toBeNull();
          return;
        }
        expect(row.durationLabel).toBe(expectedLabel(testCase.displayedSpanMs));
      });
    }
  }

  it("covers both a blank-rendering and a measured population", () => {
    // A table of all-blank or all-measured cases would let a comparator fix that
    // over- or under-applied the fold stay green on every order assertion.
    const blanks = DURATION_SORT_PARITY_CASES.filter(
      (c) => c.displayedSpanMs === null
    );
    const measured = DURATION_SORT_PARITY_CASES.filter(
      (c) => c.displayedSpanMs !== null
    );
    expect(blanks.length).toBeGreaterThan(0);
    expect(measured.length).toBeGreaterThan(0);
  });
});
