import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
} from "@repo/api/src/types/branch-phase-attribution";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({ ChecksStatus: { UNKNOWN: "UNKNOWN" } });
});

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: { findSessionDetail: vi.fn() },
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  makeSessionLink,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

// Split out of branch-read-service.test.ts, which is over the file-size ceiling
// and shrink-only (ISS-8422).
describe("branchReadService phase attribution", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  // Unconditional, never the last line of a case: a throwing assertion would
  // otherwise leak the frozen clock into every later test in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  // Renamed from "degrades malformed lifecycle evidence...": the event below is
  // rejected by `normalizeEvents` for its MISSING TIMESTAMP, and an unknown kind
  // carrying a valid timestamp never reaches that path at all — it is dropped
  // upstream while parsing the link metadata, so nothing reports it. Naming the
  // case for the unknown kind claimed coverage this does not have.
  it("degrades an untimestamped lifecycle event without emitting an unknown phase", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s1", "1.00", null, {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchLifecycleEvents: [{ kind: "future_lifecycle_kind" }],
        }),
      ])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);
    // Without a segment, projectSessionSegments returns before normalizeEvents
    // ever reads `branchLifecycleEvents`, and the case passes on whatever the PR
    // fixture happens to be rather than on the unknown boundary kind.
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        phase: "plan",
        startMs: Date.parse("2026-07-03T05:00:00.000Z"),
        endMs: Date.parse("2026-07-03T05:01:30.000Z"),
        confidence: 0.9,
      },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.lifecyclePhaseStacks).toBeUndefined();
    expect(detail?.phaseAttribution?.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.MalformedEvidence,
    });
  });
  it("compacts event evidence only after computing the detail cost metrics", async () => {
    // The branch write must precede the PR opening to place the segment in
    // Build. With the default PR opened at `now`, the later write has no phase
    // and attribution withholds every segment as lifecycle_incomplete.
    const pullRequest = makeCurrentPullRequestDetail({
      githubCreatedAt: new Date("2026-07-03T05:02:00.000Z"),
    });
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: pullRequest,
        pullRequestDetails: [pullRequest],
      })
    );
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s1", "1.00", null, {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: "2026-07-03T05:00:01.000Z",
              evidenceId: "branch-write",
            },
          ],
        }),
      ])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);
    const startMs = Date.parse("2026-07-03T05:00:00.000Z");
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        phase: "implement",
        startMs,
        endMs: startMs + 60_000,
        confidence: 0.9,
      },
    ]);
    mockDb.agentSessionTokenEvent.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        externalEventId: "priced-event",
        eventCreatedAt: new Date(startMs + 1000),
        estimatedCost: "1.00",
        inputTokens: 10n,
        outputTokens: 20n,
        cacheReadTokens: 30n,
        cacheWriteTokens: 40n,
      },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.sessions[0]?.activitySegments).toEqual([
      {
        phase: "implement",
        startMs,
        endMs: startMs + 60_000,
        confidence: 0.9,
        costUsd: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
      },
    ]);
    expect(detail?.phaseAttribution?.segments).toHaveLength(1);
    expect(detail?.phaseAttribution?.segments[0]).not.toHaveProperty(
      "costEvents"
    );
    expect(
      detail?.canonicalProjection?.detail?.phaseAttribution?.segments
    ).toEqual(detail?.phaseAttribution?.segments);
    expect(detail?.canonicalMetrics?.phaseCostUsd.build).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1,
    });
  });
});
