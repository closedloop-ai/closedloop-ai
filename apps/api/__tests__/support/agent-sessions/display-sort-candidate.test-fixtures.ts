import { Harness } from "@repo/api/src/types/agent-component";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { DisplaySortCandidate } from "@/app/agent-sessions/service/session-display-sort";

/**
 * The Sessions display-sort candidate the in-memory comparator chain ranks, with
 * every sort key pinned to one value.
 *
 * Shared by the comparator suites (ISS-8335's rule-semantics cases and ISS-9478's
 * total-order proof) so the two cannot drift on what "every other key ties"
 * means.
 */

export const DISPLAY_SORT_START = new Date("2026-08-01T00:00:00.000Z");
export const DISPLAY_SORT_RECORD_UPDATED = new Date("2026-08-02T00:00:00.000Z");

/**
 * A candidate whose every sort key is pinned except the ones a test names, so a
 * fixture cannot accidentally separate rows on a column the test is not about.
 */
export function displaySortCandidate(
  artifactId: string,
  overrides: Partial<DisplaySortCandidate> = {}
): DisplaySortCandidate {
  return {
    artifactId,
    computeTargetId: "target-1",
    externalSessionId: artifactId,
    artifact: {
      status: SESSION_STATUS.INACTIVE,
      priority: null,
      updatedAt: DISPLAY_SORT_RECORD_UPDATED,
      assignee: null,
    },
    autonomy: null,
    awaitingInputSince: null,
    endsWithError: null,
    // ISS-7176: pinned to one non-differentiating value like the other columns
    // a given case is not about; the cost cases override it.
    estimatedCost: null,
    harness: Harness.Claude,
    lastActivityAt: DISPLAY_SORT_START,
    model: "opus",
    repositoryFullName: "acme/web",
    sessionEndedAt: new Date(DISPLAY_SORT_START.getTime() + 60_000),
    sessionStartedAt: DISPLAY_SORT_START,
    updatedAt: DISPLAY_SORT_RECORD_UPDATED,
    ...overrides,
  };
}
