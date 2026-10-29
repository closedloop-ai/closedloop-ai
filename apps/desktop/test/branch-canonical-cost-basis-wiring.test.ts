/**
 * @file branch-canonical-cost-basis-wiring.test.ts
 * @description ISS-9956 — the desktop producer actually forwards the canonical
 * total estimated cost into the shared metric kernel.
 *
 * Its own file rather than a case appended to
 * `branch-canonical-metric-projection.test.ts`, which is at 973 lines: another
 * case would push it past the 1,000-line ceiling.
 *
 * What this guards is the ARGUMENT POSITION. `projectDesktopCanonicalMetrics`
 * takes the canonical basis as its fifteenth positional parameter, so a wrong
 * position binds silently to a neighbour of the same type and the ratio quietly
 * divides something else. The kernel's own tests cannot see that — they call the
 * kernel directly — so this calls the producer the way the builder does. The
 * builder-level case was removed with the local PR LOC it fed from (ISS-12709):
 * no production path supplies a published-LOC numerator through the builder.
 */
import assert from "node:assert/strict";
import {
  BranchLifecycleBoundaryKind,
  BranchStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github";
import { test } from "vitest";
import { projectDesktopCanonicalMetrics } from "../src/main/branch/branch-canonical-metric-projection.js";
import type {
  BranchLinkRow,
  BranchPrRow,
} from "../src/main/database/branch-reads.js";
import { makeBranchRowFixture } from "./shared-branches-test-helpers.js";

const BRANCH_NAME = "feature/canonical-basis";
const REPO = "acme/web";
/** 500 added + 500 removed on the merged PR. Written out, not derived. */
const PUBLISHED_LINES = 1000;
/** What the attributed token-event fold reports for this cohort. */
const ATTRIBUTED_COST_USD = 100;
/** The canonical total the builder passes in. Deliberately not the above. */
const CANONICAL_COST_USD = 200;

test("desktop forwards the canonical total estimated cost to the kernel", () => {
  const metrics = projectMetrics(CANONICAL_COST_USD);

  // The shipped ratio still divides the attributed $100 — unchanged.
  assert.deepEqual(metrics.locPerDollar.current, {
    state: BranchMetricAvailability.Complete,
    value: PUBLISHED_LINES / ATTRIBUTED_COST_USD,
  });
  // The canonical ratio divides the $200 the caller handed in. If the argument
  // bound to a different parameter, or were dropped, this is Unavailable.
  assert.deepEqual(metrics.canonicalLocPerDollar?.current, {
    state: BranchMetricAvailability.Complete,
    value: PUBLISHED_LINES / CANONICAL_COST_USD,
  });
});

test("desktop omits the canonical ratio when the caller has no total", () => {
  // The builder passes `totalSpendUsd ?? undefined`, and `totalSpendUsd` is
  // genuinely nullable — an unpriced corpus. That must withhold the ratio, not
  // divide by zero or fall back to the attributed basis.
  const metrics = projectMetrics(undefined);

  assert.deepEqual(metrics.canonicalLocPerDollar?.current, {
    state: BranchMetricAvailability.Unavailable,
    value: null,
  });
  // The sibling still computes, so the absence above is specific to the
  // canonical basis rather than the whole bundle failing.
  assert.equal(
    metrics.locPerDollar.current.state,
    BranchMetricAvailability.Complete
  );
});

function projectMetrics(canonicalEstimatedCostUsd: number | undefined) {
  const branch = makeBranchRowFixture({
    id: encodeBranchId({ repoFullName: REPO, branchName: BRANCH_NAME }),
    repoFullName: REPO,
    branchName: BRANCH_NAME,
    status: BranchStatus.Merged,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
  });
  const links = [
    { ...publicationLink(), successfulPushAt: "2026-07-31T00:00:00.000Z" },
  ];
  return projectDesktopCanonicalMetrics(
    [branch],
    links,
    [mergedPullRequest()],
    {
      startDate: "2026-07-04T00:00:00.000Z",
      endDate: "2026-08-03T00:00:00.000Z",
    },
    new Date("2026-08-03T00:00:00.000Z"),
    [usageEvent()],
    new Map([["session-1", 1]]),
    {
      activitySegmentRows: [activitySegment()],
      lifecycleEventRows: [lifecycleEvent()],
    },
    true,
    true,
    [branch],
    links,
    true,
    canonicalEstimatedCostUsd
  );
}

function mergedPullRequest(): BranchPrRow {
  return {
    repoFullName: REPO,
    branchName: BRANCH_NAME,
    prNumber: 10,
    prUrl: null,
    title: null,
    state: GitHubPRState.Merged,
    isDraft: false,
    mergedAt: "2026-08-01T00:00:00.000Z",
    closedAt: "2026-08-01T00:00:00.000Z",
    openedAt: "2026-07-30T00:00:00.000Z",
    observedAt: "2026-08-01T01:00:00.000Z",
    linesAdded: 500,
    linesRemoved: 500,
    filesChanged: 1,
  };
}

function publicationLink(): BranchLinkRow {
  return {
    repoFullName: REPO,
    branchName: BRANCH_NAME,
    hasLocalPublication: true,
    successfulPushAt: "2026-08-02T00:00:00.000Z",
    sessionId: "session-1",
    sessionName: "work",
    isPrimary: true,
    observedAt: "2026-08-02T00:00:00.000Z",
    activityAt: "2026-08-02T00:00:00.000Z",
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    ownerUserId: null,
    priority: null,
  };
}

function usageEvent() {
  return {
    eventRowId: "1",
    eventFingerprint: "event-1",
    sessionId: "session-1",
    model: "test-model",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    billingMode: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    sessionStartedAt: "2026-08-01T00:00:00.000Z",
    costUsdEstimated: ATTRIBUTED_COST_USD,
  };
}

function activitySegment() {
  return {
    sessionId: "session-1",
    phase: "implement",
    startMs: Date.parse("2026-08-01T00:00:00.000Z"),
    endMs: Date.parse("2026-08-01T00:01:00.000Z"),
    confidence: 1,
  };
}

function lifecycleEvent() {
  return {
    repoFullName: REPO,
    branchName: BRANCH_NAME,
    sessionId: "session-1",
    sessionStartedAt: "2026-08-01T00:00:00.000Z",
    sessionEndedAt: "2026-08-01T00:01:00.000Z",
    kind: BranchLifecycleBoundaryKind.BranchWrite,
    observedAt: "2026-08-01T00:00:30.000Z",
    evidenceId: "push-1",
    method: "git_push",
  };
}
