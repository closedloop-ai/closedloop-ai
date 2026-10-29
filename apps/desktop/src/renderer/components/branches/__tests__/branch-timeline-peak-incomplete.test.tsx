import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { timelinePeakBucketLabel } from "@repo/app/agents/components/detail/timeline-peak-bucket-fact";
import { TimelineScale } from "@repo/app/agents/lib/session-timeline-scale";
import {
  makeBranchDetail,
  makeBranchSession,
} from "@repo/app/branches/__tests__/branch-fixtures";
import {
  BranchTimelineMountHarness,
  SESSIONS_TIMELINE_TAB,
} from "@repo/app/branches/__tests__/branch-timeline-mount-harness";
import { BranchDetailPage } from "@repo/app/branches/components/branch-detail-page";
import {
  formatTimelineEvidenceValue,
  TimelineTraceEvidence,
} from "@repo/app/branches/components/branch-pr-activity-timeline-helpers";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
import { render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #9008 review (whitlockk): the DESKTOP adapter mounts the same Branch timeline
 * header (`BranchDetailPage` → `BranchSessionsTimelineTab` →
 * `BranchPrActivityTimeline`), so a session that failed to hydrate must mark
 * the peak column incomplete here too, exactly as it marks cost and duration.
 * The web side is `packages/app/branches/components/__tests__/
 * branch-pr-activity-timeline-peak-bucket.test.tsx`.
 */

const originalTimezone = process.env.TZ;
const PEAK_LABEL = timelinePeakBucketLabel(TimelineScale.OneHour);
const LOADED_ID = "loaded-session";
const FAILED_ID = "failed-session";

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

describe("desktop Branch timeline peak with a session that failed to hydrate", () => {
  it("marks the peak incomplete, as the adjacent duration is", async () => {
    const detail = makeBranchDetail({
      additions: 100,
      attributedCostUsd: 65,
      deletions: 0,
      estimatedCostUsd: 65,
      sessionIds: [LOADED_ID, FAILED_ID],
      sessions: [
        hourSession(LOADED_ID, "2026-06-10T10:00:00.000Z", 25),
        hourSession(FAILED_ID, "2026-06-13T10:00:00.000Z", 40),
      ],
    });
    const { container } = render(
      <BranchTimelineMountHarness dataSource={partialTraceSource}>
        <BranchDetailPage
          backHref="/branches"
          branchId={detail.id}
          detail={detail}
          initialTab={SESSIONS_TIMELINE_TAB}
          isError={false}
          isLoading={false}
        />
      </BranchTimelineMountHarness>
    );

    await waitFor(() => {
      expect(peakFact(container).textContent).toBe(
        `${PEAK_LABEL} ${formatTimelineEvidenceValue(
          formatCostPrecise(25),
          TimelineTraceEvidence.Incomplete
        )}`
      );
    });
  });
});

function hourSession(sessionId: string, startedAt: string, costUsd: number) {
  return makeBranchSession({
    endedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
    estimatedCostUsd: costUsd,
    ownerUserName: "Cosimo",
    sessionId,
    slug: sessionId,
    startedAt,
  });
}

const partialTrace: BranchTraceState & { items: [] } = {
  aggregateCompleteness: { state: BranchTraceCompletenessState.Incomplete },
  completeness: { state: BranchTraceCompletenessState.Incomplete },
  items: [],
  qualifyingSessionCount: 2,
  sessions: [
    {
      identity: {
        artifactId: LOADED_ID,
        name: null,
        navigableRef: LOADED_ID,
        slug: null,
      },
      state: BranchTraceSessionHydrationState.Loaded,
    },
    {
      identity: {
        artifactId: FAILED_ID,
        name: null,
        navigableRef: FAILED_ID,
        slug: null,
      },
      reason: BranchTraceUnavailableReason.Permission,
      state: BranchTraceSessionHydrationState.Unavailable,
    },
  ],
};

const partialTraceSource: BranchesDataSource = {
  scope: "branch-timeline-peak-incomplete",
  analytics: () => Promise.reject(new Error("analytics unused")),
  comments: () => Promise.reject(new Error("comments unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  list: () => Promise.reject(new Error("list unused")),
  pageData: () => Promise.reject(new Error("pageData unused")),
  trace: () => Promise.resolve(partialTrace),
  usage: () => Promise.reject(new Error("usage unused")),
};

function peakFact(container: HTMLElement): HTMLElement {
  const fact = [
    ...container.querySelectorAll<HTMLElement>(".bq-stats span"),
  ].find((node) => node.textContent?.startsWith(PEAK_LABEL));
  if (!fact) {
    throw new Error("timeline header rendered no peak fact");
  }
  return fact;
}
