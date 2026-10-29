/**
 * ISS-12665: the Branch PR timeline header states its costliest column at the
 * current scale, through the same `TimelinePeakBucketFact` the Session Timeline
 * uses. UTC is pinned so each session hour lands on exactly one `1h` column.
 */
import type { BranchSession } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { timelinePeakBucketLabel } from "@repo/app/agents/components/detail/timeline-peak-bucket-fact";
import { TimelineScale } from "@repo/app/agents/lib/session-timeline-scale";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";
import {
  formatTimelineEvidenceValue,
  TimelineTraceEvidence,
} from "../branch-pr-activity-timeline-helpers";

const originalTimezone = process.env.TZ;
const EM_DASH = "—";
const ANY_MONEY_RE = /\$/;
const PEAK_LABEL = timelinePeakBucketLabel(TimelineScale.OneHour);
const INCOMPLETE_EVIDENCE_RE = /trace evidence could not be loaded/;

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

describe("BranchPrActivityTimeline peak column (ISS-12665)", () => {
  it("states the costliest hour, even when the scrubber has panned past it", () => {
    const sessions = [
      session("s1", "2026-06-10T10:00:00.000Z", 25),
      session("s2", "2026-06-13T10:00:00.000Z", 4),
    ];
    const { container } = render(
      <BranchPrActivityTimeline
        detail={pricedDetail(sessions)}
        traceState={loadedTrace(sessions)}
        windowStart={Number.MAX_SAFE_INTEGER}
      />
    );

    expect(peakFact(container)).toHaveTextContent(
      `${PEAK_LABEL} ${formatCostPrecise(25)}`
    );
  });

  it("states a tied peak once rather than summing the tied hours", () => {
    const sessions = [
      session("s1", "2026-06-10T10:00:00.000Z", 6),
      session("s2", "2026-06-10T14:00:00.000Z", 6),
    ];
    const { container } = render(
      <BranchPrActivityTimeline
        detail={pricedDetail(sessions)}
        traceState={loadedTrace(sessions)}
      />
    );

    expect(peakFact(container)).toHaveTextContent(
      `${PEAK_LABEL} ${formatCostPrecise(6)}`
    );
  });

  it("is not a tooltip trigger: the prototype's sentence describes one session", () => {
    const sessions = [session("s1", "2026-06-10T10:00:00.000Z", 25)];
    const { container } = render(
      <BranchPrActivityTimeline
        detail={pricedDetail(sessions)}
        traceState={loadedTrace(sessions)}
      />
    );

    expect(peakFact(container).closest("button")).toBeNull();
  });

  it("shows a dash, never a figure, when the Branch cost is unavailable", () => {
    const sessions = [session("s1", "2026-06-10T10:00:00.000Z", 25)];
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY],
        })}
      >
        <BranchPrActivityTimeline
          detail={makeBranchDetail({
            additions: 100,
            deletions: 0,
            estimatedCostUsd: null,
            sessions,
          })}
          traceState={null}
        />
      </FeatureFlagAdapterProvider>
    );

    const fact = peakFact(container);
    expect(fact).toHaveTextContent(`${PEAK_LABEL} ${EM_DASH}`);
    expect(fact.textContent).not.toMatch(ANY_MONEY_RE);
  });
});

describe("BranchPrActivityTimeline peak column with a session that failed to hydrate (#9008 review)", () => {
  it("marks the peak incomplete and points it at the disclosure, as cost and duration are", () => {
    const sessions = [
      session("s1", "2026-06-10T10:00:00.000Z", 25),
      session("s2", "2026-06-13T10:00:00.000Z", 40),
    ];
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY],
        })}
      >
        <BranchPrActivityTimeline
          detail={pricedDetail(sessions)}
          traceState={traceWithUnavailableSession(sessions, "s2")}
        />
      </FeatureFlagAdapterProvider>
    );

    const figure = peakFigure(container);
    expect(figure).toHaveTextContent(
      formatTimelineEvidenceValue(
        formatCostPrecise(25),
        TimelineTraceEvidence.Incomplete
      )
    );
    const disclosureId = figure.getAttribute("aria-describedby");
    expect(disclosureId).toBeTruthy();
    expect(
      container.ownerDocument.getElementById(disclosureId ?? "")
    ).toHaveTextContent(INCOMPLETE_EVIDENCE_RE);
  });

  it("leaves the peak unmarked when every session hydrated", () => {
    const sessions = [
      session("s1", "2026-06-10T10:00:00.000Z", 25),
      session("s2", "2026-06-13T10:00:00.000Z", 40),
    ];
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY],
        })}
      >
        <BranchPrActivityTimeline
          detail={pricedDetail(sessions)}
          traceState={loadedTrace(sessions)}
        />
      </FeatureFlagAdapterProvider>
    );

    const figure = peakFigure(container);
    expect(figure.textContent).toBe(formatCostPrecise(40));
    expect(figure).not.toHaveAttribute("aria-describedby");
  });
});

function session(
  sessionId: string,
  startedAt: string,
  costUsd: number
): BranchSession {
  return makeBranchSession({
    endedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
    estimatedCostUsd: costUsd,
    ownerUserName: "Cosimo",
    sessionId,
    slug: sessionId.toUpperCase(),
    startedAt,
  });
}

function pricedDetail(sessions: BranchSession[]) {
  const total = sessions.reduce(
    (sum, row) => sum + (row.estimatedCostUsd ?? 0),
    0
  );
  return makeBranchDetail({
    additions: 100,
    attributedCostUsd: total,
    deletions: 0,
    estimatedCostUsd: total,
    sessionIds: sessions.map((row) => row.sessionId),
    sessions,
  });
}

function loadedTrace(sessions: BranchSession[]) {
  return {
    aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    completeness: { state: BranchTraceCompletenessState.Complete },
    qualifyingSessionCount: sessions.length,
    sessions: sessions.map((row) => ({
      identity: {
        artifactId: row.sessionId,
        name: row.slug ?? row.sessionId,
        navigableRef: row.slug ?? row.sessionId,
        slug: row.slug ?? row.sessionId,
      },
      state: BranchTraceSessionHydrationState.Loaded,
    })),
  };
}

function peakFact(container: HTMLElement): HTMLElement {
  const fact = [
    ...container.querySelectorAll<HTMLElement>(".bq-stats span"),
  ].find((node) => node.textContent?.startsWith(PEAK_LABEL));
  if (!fact) {
    throw new Error("timeline header rendered no peak fact");
  }
  return fact;
}

/** Every session loaded except `unavailableId`, as a failed hydration reports. */
function traceWithUnavailableSession(
  sessions: BranchSession[],
  unavailableId: string
): BranchTraceState {
  const loaded = loadedTrace(sessions);
  return {
    ...loaded,
    aggregateCompleteness: { state: BranchTraceCompletenessState.Incomplete },
    completeness: { state: BranchTraceCompletenessState.Incomplete },
    sessions: loaded.sessions.map((row) =>
      row.identity.artifactId === unavailableId
        ? {
            identity: row.identity,
            reason: BranchTraceUnavailableReason.Permission,
            state: BranchTraceSessionHydrationState.Unavailable,
          }
        : row
    ),
  };
}

function peakFigure(container: HTMLElement): HTMLElement {
  const figure = peakFact(container).querySelector("b");
  if (!figure) {
    throw new Error("peak fact rendered no figure");
  }
  return figure;
}
