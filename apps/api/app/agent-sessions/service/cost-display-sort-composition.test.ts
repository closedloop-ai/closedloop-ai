// FEA-4276 thread #1/#4 + ISS-4675: a cost-bucket filter COMPOSED with a
// display-value sort (Owner / Duration).
//
// The cost-reconciled path narrows candidate rows through its own mapper
// (`toCostReconcileCandidate` in `list-page-fetch.ts`) before handing the
// survivors to the shared display-value comparators, so it is a SECOND place the
// displayed-value ordering can be derived — and a second place it can silently
// diverge from the plain (`findDisplayValueSortedPage`) path. Split out of
// `cost-query-reconciliation.test.ts` (ISS-4675) so that file stays under the
// 1,000-line ceiling and this composition seam has its own owner.
//
// Its sibling, `list-display-sort.integration.test.ts`, pins the same orderings
// on the plain path; the two must agree.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installCostSessions,
  resetCapturedQueryRaw,
  UNDER_1_BUCKET,
  UPDATED,
} from "@/__tests__/support/agent-sessions/service/cost-query-reconciliation.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

describe("cost-bucket filter composed with a display-value sort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCapturedQueryRaw();
  });

  it("honors an Owner sort composed with a cost-bucket filter — orders survivors by DISPLAYED name, not recency (thread #1/#4)", async () => {
    // Both sessions' RECONCILED cost is < $1, so both survive the < $1 bucket.
    // Recency (the candidate DB order) would be Zed-first (later updatedAt); the
    // requested Owner ASC sort must re-order the survivors to Ada < Zed. A session
    // whose reconciled cost falls OUTSIDE the bucket ($50+) is excluded entirely.
    installCostSessions([
      {
        artifactId: "row-zed",
        storedRollup: 0.5,
        eventCostSum: 0.5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(9), // newest → first by recency
        user: { firstName: "Zed", lastName: "Young", email: "z@example.com" },
      },
      {
        artifactId: "row-ada",
        storedRollup: 0.4,
        eventCostSum: 0.4,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
        user: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "a@example.com",
        },
      },
      {
        artifactId: "row-expensive",
        storedRollup: 90,
        eventCostSum: 90, // reconciled $90 → NOT in < $1 → excluded
        eventCount: 2,
        sessionUpdatedAt: UPDATED(5),
        user: { firstName: "Bob", lastName: "Ng", email: "b@example.com" },
      },
    ]);

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        costBuckets: [UNDER_1_BUCKET],
        sortBy: "user",
        sortDir: "asc",
        quality: "all",
      },
    });

    // Cost bucket filters to the two < $1 rows; Owner ASC orders them by name.
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual(["row-ada", "row-zed"]);
  });

  it("honors a Duration sort composed with a cost-bucket filter — orders survivors by DISPLAYED span (thread #1/#4)", async () => {
    // Both survive the < $1 bucket; the requested Duration DESC sort orders them
    // by the displayed span (longer first), independent of recency/cost order.
    installCostSessions([
      {
        artifactId: "d-short",
        storedRollup: 0.5,
        eventCostSum: 0.5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(9), // newest → first by recency
        sessionStartedAt: UPDATED(0),
        sessionEndedAt: new Date(UPDATED(0).getTime() + 1000), // 1s
      },
      {
        artifactId: "d-long",
        storedRollup: 0.4,
        eventCostSum: 0.4,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
        sessionStartedAt: UPDATED(0),
        sessionEndedAt: new Date(UPDATED(0).getTime() + 60_000), // 60s
      },
    ]);

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        costBuckets: [UNDER_1_BUCKET],
        sortBy: "duration",
        sortDir: "desc",
        quality: "all",
      },
    });

    expect(page.total).toBe(2);
    // Duration DESC: 60s (d-long) before 1s (d-short) — recency would reverse it.
    expect(page.items.map((item) => item.id)).toEqual(["d-long", "d-short"]);
  });

  it("ISS-5131: a Duration sort composed with a cost-bucket filter orders by the session's own span, like the plain path", async () => {
    // The cost path narrows candidates through its OWN mapper before handing
    // them to the duration comparator. If that narrowing drops either Duration
    // input (`sessionEndedAt` or the status on `artifact`), the cost-filtered
    // page orders by a different rule than the unfiltered page — two different
    // orders for the same rows. Each row's `wallClock` is set to the REVERSE of
    // its real span, so a regression to the collector headline flips the result.
    installCostSessions([
      {
        artifactId: "w-short",
        storedRollup: 0.5,
        eventCostSum: 0.5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(9),
        sessionStartedAt: UPDATED(0),
        sessionEndedAt: new Date(UPDATED(0).getTime() + 60_000),
        wallClock: "2h",
      },
      {
        artifactId: "w-long",
        storedRollup: 0.4,
        eventCostSum: 0.4,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
        sessionStartedAt: UPDATED(0),
        sessionEndedAt: new Date(UPDATED(0).getTime() + 3 * 3_600_000),
        wallClock: "5m",
      },
    ]);

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        costBuckets: [UNDER_1_BUCKET],
        sortBy: "duration",
        sortDir: "desc",
        quality: "all",
      },
    });

    expect(page.total).toBe(2);
    // Real spans DESC: 3h (w-long) then 1m (w-short). A wallClock-keyed
    // narrowing would emit the reverse.
    expect(page.items.map((item) => item.id)).toEqual(["w-long", "w-short"]);
  });
});
