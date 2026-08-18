import type { BranchSelectedPullRequestDetail } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail as detail } from "../../__tests__/branch-fixtures";
import { BranchLeadTimeWaterfall } from "../branch-lead-time-waterfall";

const OPENED = "2026-08-01T10:30:00.000Z";
const TERMINAL = "2026-08-01T12:00:00.000Z";
const PARTIAL_TOTAL_RE = /120m 0s\*/;

describe("BranchLeadTimeWaterfall", () => {
  it("renders the selected merged cycle as Build, Review, Rework, and Idle", () => {
    const { container } = render(
      <BranchLeadTimeWaterfall detail={outcomeDetail("merged")} />
    );

    expect(screen.getByText("Lead time for change")).toBeInTheDocument();
    expect(screen.getByText("First code pushed")).toBeInTheDocument();
    expect(screen.getByText("PR opened")).toBeInTheDocument();
    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Rework")).toBeInTheDocument();
    expect(screen.getByText("Idle / waiting")).toBeInTheDocument();
    expect(screen.getByText("120m 0s · 25% idle")).toBeInTheDocument();
    expect(container.querySelectorAll(".bq-lead-seg")).toHaveLength(3);
    expect(container.querySelectorAll(".bq-lead-gap")).toHaveLength(2);
  });

  it("renders closed-unmerged selected cycles as Abandonment Duration", () => {
    render(<BranchLeadTimeWaterfall detail={outcomeDetail("closed")} />);

    expect(screen.getByText("Abandonment Duration")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText("Merged")).not.toBeInTheDocument();
  });

  it("moves a near-edge PR-opened label onto its own axis line", () => {
    const { container } = render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          openedAt: "2026-08-01T10:01:00.000Z",
        })}
      />
    );

    expect(container.querySelector(".bq-lead-axis")).toHaveAttribute(
      "data-pr-opened-edge",
      "start"
    );
    expect(screen.getByText("PR opened")).toHaveAttribute("data-edge", "start");
  });

  it("clips segments to the selected cycle and gives overlapping time to phase precedence", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          segments: [
            phaseSegment(BranchVisibleLifecyclePhase.Build, "09:30", "11:00"),
            phaseSegment(BranchVisibleLifecyclePhase.Review, "10:45", "11:30"),
            phaseSegment(BranchVisibleLifecyclePhase.Rework, "11:15", "12:30"),
          ],
        })}
      />
    );

    expect(screen.getAllByText("45m 0s", { selector: "b" })).toHaveLength(2);
    expect(screen.getByText("30m 0s", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText("0ms", { selector: "b" })).toBeInTheDocument();
  });

  it("marks a defensible partial outcome and discloses the incomplete evidence", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", {
          leadTimeMs: partial(2 * 60 * 60 * 1000),
          completeness: BranchPhaseAttributionCompleteness.Partial,
        })}
      />
    );

    expect(screen.getByText(PARTIAL_TOTAL_RE)).toBeInTheDocument();
    expect(
      screen.getByText("* Calculated from available selected-cycle evidence.")
    ).toBeInTheDocument();
  });

  it("reports unavailable when the selected-cycle anchor is indefensible", () => {
    render(
      <BranchLeadTimeWaterfall
        detail={outcomeDetail("merged", { leadTimeMs: unavailable() })}
      />
    );

    expect(
      screen.getByText(
        "Selected-cycle outcome evidence is unavailable or not applicable."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("First code pushed")).not.toBeInTheDocument();
  });
});

function outcomeDetail(
  outcome: "closed" | "merged",
  overrides: {
    completeness?:
      | typeof BranchPhaseAttributionCompleteness.Complete
      | typeof BranchPhaseAttributionCompleteness.Partial;
    leadTimeMs?: BranchMetricResult<number>;
    openedAt?: string;
    segments?: BranchPhaseAttributionResult["segments"];
  } = {}
) {
  const duration = 2 * 60 * 60 * 1000;
  const lead = outcome === "merged" ? complete(duration) : notApplicable();
  const abandonment =
    outcome === "closed" ? complete(duration) : notApplicable();
  return detail({
    selectedPullRequest: selectedPullRequest(outcome, overrides.openedAt),
    canonicalMetrics: {
      abandonmentTimeMs: abandonment,
      idleTimeMs: complete(30 * 60 * 1000),
      leadTimeMs: overrides.leadTimeMs ?? lead,
      locPerDollar: unavailable(),
      phaseCostUsd: {
        [BranchVisibleLifecyclePhase.Build]: unavailable(),
        [BranchVisibleLifecyclePhase.Review]: unavailable(),
        [BranchVisibleLifecyclePhase.Rework]: unavailable(),
      },
      totalCostUsd: unavailable(),
    },
    phaseAttribution: attribution(
      overrides.segments ?? [
        phaseSegment(BranchVisibleLifecyclePhase.Build, "10:00", "10:30"),
        phaseSegment(BranchVisibleLifecyclePhase.Review, "10:45", "11:15"),
        phaseSegment(BranchVisibleLifecyclePhase.Rework, "11:30", "12:00"),
      ],
      overrides.completeness ?? BranchPhaseAttributionCompleteness.Complete
    ),
  });
}

function selectedPullRequest(
  outcome: "closed" | "merged",
  openedAt = OPENED
): BranchSelectedPullRequestDetail {
  return {
    id: "acme/web#42",
    repositoryFullName: "acme/web",
    number: 42,
    title: "Selected PR",
    url: "https://github.com/acme/web/pull/42",
    state: outcome === "merged" ? GitHubPRState.Merged : GitHubPRState.Closed,
    isDraft: false,
    reviewDecision: null,
    openedAt,
    closedAt: outcome === "closed" ? TERMINAL : null,
    mergedAt: outcome === "merged" ? TERMINAL : null,
    body: null,
    headRefOid: null,
    mergeCommitSha: null,
    changedFiles: null,
    additions: null,
    deletions: null,
  };
}

function attribution(
  segments: BranchPhaseAttributionResult["segments"],
  completeness:
    | typeof BranchPhaseAttributionCompleteness.Complete
    | typeof BranchPhaseAttributionCompleteness.Partial
): BranchPhaseAttributionResult {
  const subtotalUsd = segments.reduce(
    (sum, segment) => sum + segment.estimatedCostUsd,
    0
  );
  const coverage =
    completeness === BranchPhaseAttributionCompleteness.Complete
      ? { completeness, subtotalUsd }
      : {
          completeness: BranchPhaseAttributionCompleteness.Partial,
          reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
          subtotalUsd,
        };
  return {
    segments,
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      sessionCount: 1,
    })),
    coverage,
  };
}

function phaseSegment(
  phase: BranchVisibleLifecyclePhase,
  start: string,
  end: string
) {
  return {
    sessionId: `${phase}-${start}`,
    sequence: 0,
    phase,
    startMs: Date.parse(`2026-08-01T${start}:00.000Z`),
    endMs: Date.parse(`2026-08-01T${end}:00.000Z`),
    estimatedCostUsd: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    evidenceIds: [],
  };
}

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

function partial(value: number): BranchMetricResult<number> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure: BranchMetricDisclosure.DefaultIncomplete,
  };
}

function unavailable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}

function notApplicable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}
