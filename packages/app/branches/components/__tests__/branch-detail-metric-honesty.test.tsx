import type { BranchSelectedPullRequestDetail } from "@repo/api/src/types/branch";
import type { BranchAssociatedPullRequestCollection } from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag";
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricId,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import {
  BRANCH_CYCLE_TIME_LABEL,
  BRANCH_OUTCOME_EVIDENCE_ABSENT,
  BRANCH_OUTCOME_IDLE_UNAVAILABLE_FOOTNOTE,
  BRANCH_OUTCOME_IDLE_UNAVAILABLE_SUMMARY,
} from "../../lib/branch-outcome-copy";
import {
  BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE,
  BranchCostToMerge,
} from "../branch-cost-to-merge";
import { BranchHeadlineCards } from "../branch-headline-cards";
import { BranchLeadTimeWaterfall } from "../branch-lead-time-waterfall";

const TERMINAL = "2026-08-01T12:00:00.000Z";
const OPENED = "2026-08-01T10:30:00.000Z";
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
/** The ticket's photographed 53-hour Abandonment Duration, once "3180m 0s". */
const FIFTY_THREE_HOURS_MS = 190_800_000;
/** A Cost breakdown phase row that reads "185m 0s" on the shipped formatter. */
const THREE_HOURS_FIVE_MINUTES_MS = 11_100_000;
const LEAD_TIME_LABEL = BRANCH_METRIC_DICTIONARY[BranchMetricId.LeadTime].label;
const SELECT_PULL_REQUEST_DETAIL = "Select a pull request to see this.";

describe("Branch detail outcome presentation (ISS-6954/6955/6957/6958)", () => {
  /**
   * ISS-6954. The assertion is about the SCREEN, so both components render in
   * one tree exactly as `BranchSelectedPullRequestWorkspace` mounts them. A test
   * that only checked the card's label would pass while the waterfall below it
   * went on naming the same measurement.
   */
  it("names the outcome measurement once across the card and the waterfall", () => {
    renderScreen({ enabled: true });

    expect(screen.getAllByText(BRANCH_CYCLE_TIME_LABEL)).toHaveLength(1);
    expect(screen.queryByText(LEAD_TIME_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText("Outcome breakdown")).toBeInTheDocument();
  });

  /**
   * The flag-off sibling, and the reason the test above cannot pass vacuously:
   * it pins the shipped defect, so a change that stopped rendering either
   * component would fail HERE rather than quietly satisfying the negative
   * assertion above.
   */
  it("still names it twice with the flag off, as shipped", () => {
    renderScreen({ enabled: false });

    expect(screen.getAllByText(LEAD_TIME_LABEL)).toHaveLength(2);
    expect(screen.queryByText(BRANCH_CYCLE_TIME_LABEL)).not.toBeInTheDocument();
  });

  /**
   * ISS-6955. No outcome track, on a branch that never merged: the heading used
   * to hard-code the merged-outcome label regardless of the actual outcome.
   */
  it("stops the trackless waterfall claiming a merged-outcome measurement", () => {
    renderWaterfall({ enabled: true, detail: tracklessClosedDetail() });

    expect(screen.getByText("Outcome breakdown")).toBeInTheDocument();
    expect(screen.queryByText(LEAD_TIME_LABEL)).not.toBeInTheDocument();
  });

  it("hard-codes the merged label on that same branch with the flag off", () => {
    renderWaterfall({ enabled: false, detail: tracklessClosedDetail() });

    expect(screen.getByText(LEAD_TIME_LABEL)).toBeInTheDocument();
  });

  /**
   * ISS-6957. Three absent states, three sentences — and the card that does NOT
   * depend on a pull request keeps its own. Asserting only that "Evidence is
   * unavailable." disappeared would pass if every card had been given the same
   * new sentence, which is the same defect wearing new copy.
   */
  it("names the unselected pull request only on the cards that depend on one", () => {
    renderCards({
      enabled: true,
      detail: prLessDetail(selectableCollection()),
    });

    expect(screen.getAllByText(SELECT_PULL_REQUEST_DETAIL)).toHaveLength(2);
    expect(screen.getByText("Evidence is unavailable.")).toBeInTheDocument();
    expect(screen.getAllByText("No PR selected")).toHaveLength(2);
  });

  it("keeps unreadable pull-request history an outage rather than an action", () => {
    renderCards({ enabled: true, detail: prLessDetail(undefined) });

    expect(
      screen.getAllByText("Pull request history isn't available yet.")
    ).toHaveLength(2);
    expect(
      screen.queryByText(SELECT_PULL_REQUEST_DETAIL)
    ).not.toBeInTheDocument();
  });

  it("reports every PR-less card as an evidence outage with the flag off", () => {
    renderCards({
      enabled: false,
      detail: prLessDetail(selectableCollection()),
    });

    expect(screen.getAllByText("Evidence is unavailable.")).toHaveLength(3);
  });

  /**
   * ISS-6958. The headline card and the waterfall total, on the same screen,
   * both scaling past minutes.
   */
  it("scales a fifty-three hour outcome into days and hours", () => {
    renderCards({ enabled: true, detail: abandonedDetail() });

    expect(screen.getByText("2d 5h")).toBeInTheDocument();
    expect(screen.queryByText("3180m 0s")).not.toBeInTheDocument();
  });

  it("renders that same outcome in raw minutes with the flag off", () => {
    renderCards({ enabled: false, detail: abandonedDetail() });

    expect(screen.getByText("3180m 0s")).toBeInTheDocument();
  });

  it("drops the zero-seconds component from the waterfall total", () => {
    renderWaterfall({ enabled: true, detail: mergedTrackDetail() });

    expect(screen.getByText("2h · 25% idle")).toBeInTheDocument();
  });

  it("keeps the zero-seconds waterfall total with the flag off", () => {
    renderWaterfall({ enabled: false, detail: mergedTrackDetail() });

    expect(screen.getByText("120m 0s · 25% idle")).toBeInTheDocument();
  });

  it("preserves attribution-derived waterfall idle with the flag off", () => {
    renderWaterfall({
      enabled: false,
      detail: mergedTrackDetail({ idleTimeMs: unavailable() }),
    });

    expect(screen.getByText("120m 0s · 25% idle")).toBeInTheDocument();
    expect(
      screen.getAllByText("30m 0s", { selector: "b" }).length
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText(BRANCH_OUTCOME_IDLE_UNAVAILABLE_SUMMARY, {
        exact: false,
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(BRANCH_OUTCOME_IDLE_UNAVAILABLE_FOOTNOTE)
    ).not.toBeInTheDocument();
  });

  /**
   * ISS-6957, davetho review on PR #6194. The waterfall breaks down the
   * SELECTED pull request's cycle, so on a branch with none it was reporting an
   * evidence outage for the same reason the two cards above it now name as the
   * pull request. One screen, two answers to one question.
   */
  it("gives the trackless waterfall the same pull-request reason as the cards", () => {
    renderScreenWithoutPullRequest({ enabled: true });

    // Three: the two PR-cycle cards, and now the section that decomposes them.
    expect(screen.getAllByText(SELECT_PULL_REQUEST_DETAIL)).toHaveLength(3);
    expect(
      screen.queryByText(BRANCH_OUTCOME_EVIDENCE_ABSENT)
    ).not.toBeInTheDocument();
  });

  it("reports the PR-less waterfall as an evidence outage with the flag off", () => {
    renderScreenWithoutPullRequest({ enabled: false });

    expect(
      screen.getByText(BRANCH_OUTCOME_EVIDENCE_ABSENT)
    ).toBeInTheDocument();
  });

  /**
   * The other half of that fix, and the reason it is not "the waterfall always
   * blames the pull request": with a pull request selected and its cycle still
   * untrackable, the evidence IS what is missing, and the shipped sentence is
   * the honest one.
   */
  it("keeps the evidence sentence when a pull request is selected", () => {
    renderWaterfall({ enabled: true, detail: tracklessClosedDetail() });

    expect(
      screen.getByText(BRANCH_OUTCOME_EVIDENCE_ABSENT)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(SELECT_PULL_REQUEST_DETAIL)
    ).not.toBeInTheDocument();
  });

  /**
   * ISS-6958, davetho review on PR #6194. "One duration treatment for the
   * screen" has to include Cost breakdown, which shares the screen with the
   * cards and the waterfall inside the same selected-PR workspace. Left behind,
   * the flag put "185m 0s" one section below "3h 5m" for a duration of the same
   * order — the flag introducing the inconsistency it was taken out to remove.
   */
  it("scales the Cost breakdown phase rows with the rest of the screen", () => {
    renderCostBreakdown({ enabled: true });

    expect(screen.getByText("3h 5m · $6.00 · 60%")).toBeInTheDocument();
    expect(screen.queryByText("185m 0s · $6.00 · 60%")).not.toBeInTheDocument();
  });

  it("leaves those phase rows in raw minutes with the flag off", () => {
    renderCostBreakdown({ enabled: false });

    expect(screen.getByText("185m 0s · $6.00 · 60%")).toBeInTheDocument();
  });

  it("preserves shipped cost clamping with the flag off", () => {
    renderCostBreakdown({
      enabled: false,
      detail: costBreakdownDetail({ buildCostUsd: -1 }),
    });

    expect(
      screen.queryByText(BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE)
    ).not.toBeInTheDocument();
    expect(screen.getByText("185m 0s · $0.00 · 0%")).toBeInTheDocument();
  });

  it("withholds malformed and oversized metric-card payloads with the flag on", () => {
    renderCards({
      enabled: true,
      detail: makeBranchDetail({
        selectedPullRequest: selectedPullRequest(GitHubPRState.Merged),
        canonicalMetrics: metrics({
          abandonmentTimeMs: complete(-1),
          leadTimeMs: complete(1e308),
          locPerDollar: complete(Number.NaN),
        }),
      }),
    });

    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(screen.getAllByText("Evidence is unavailable.")).toHaveLength(3);
    expect(screen.queryByText("-1ms")).not.toBeInTheDocument();
  });

  it("preserves shipped malformed metric-card values with the flag off", () => {
    renderCards({
      enabled: false,
      detail: makeBranchDetail({
        selectedPullRequest: selectedPullRequest(GitHubPRState.Merged),
        canonicalMetrics: metrics({
          abandonmentTimeMs: complete(-1),
          leadTimeMs: notApplicable(),
          locPerDollar: unavailable(),
        }),
      }),
    });

    expect(screen.getByText("-1ms")).toBeInTheDocument();
  });

  it("withholds unknown runtime metric states with the flag on", () => {
    renderCards({
      enabled: true,
      detail: makeBranchDetail({
        selectedPullRequest: selectedPullRequest(GitHubPRState.Merged),
        canonicalMetrics: metrics({
          abandonmentTimeMs: notApplicable(),
          leadTimeMs: runtimeMetric("future_metric", TWO_HOURS_MS),
          locPerDollar: complete(21),
        }),
      }),
    });

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("2h")).not.toBeInTheDocument();
  });

  it("preserves shipped unknown metric states with the flag off", () => {
    renderCards({
      enabled: false,
      detail: makeBranchDetail({
        selectedPullRequest: selectedPullRequest(GitHubPRState.Merged),
        canonicalMetrics: metrics({
          abandonmentTimeMs: notApplicable(),
          leadTimeMs: runtimeMetric("future_metric", TWO_HOURS_MS),
          locPerDollar: unavailable(),
        }),
      }),
    });

    expect(screen.getByText("120m 0s")).toBeInTheDocument();
  });
});

function withFlag(enabled: boolean, children: ReactNode) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY] : [],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function renderScreen({ enabled }: { enabled: boolean }) {
  const detail = mergedTrackDetail();
  return withFlag(
    enabled,
    <>
      <BranchHeadlineCards detail={detail} />
      <BranchLeadTimeWaterfall detail={detail} />
    </>
  );
}

function renderCards({
  enabled,
  detail,
}: {
  enabled: boolean;
  detail: ReturnType<typeof makeBranchDetail>;
}) {
  return withFlag(enabled, <BranchHeadlineCards detail={detail} />);
}

function renderWaterfall({
  enabled,
  detail,
}: {
  enabled: boolean;
  detail: ReturnType<typeof makeBranchDetail>;
}) {
  return withFlag(enabled, <BranchLeadTimeWaterfall detail={detail} />);
}

/** The cards and the section that decomposes them, as the workspace mounts them. */
function renderScreenWithoutPullRequest({ enabled }: { enabled: boolean }) {
  const detail = prLessDetail(selectableCollection());
  return withFlag(
    enabled,
    <>
      <BranchHeadlineCards detail={detail} />
      <BranchLeadTimeWaterfall detail={detail} />
    </>
  );
}

function renderCostBreakdown({
  enabled,
  detail = costBreakdownDetail(),
}: {
  detail?: ReturnType<typeof makeBranchDetail>;
  enabled: boolean;
}) {
  return withFlag(enabled, <BranchCostToMerge detail={detail} />);
}

function mergedTrackDetail(
  overrides: { idleTimeMs?: BranchMetricResult<number> } = {}
) {
  return makeBranchDetail({
    selectedPullRequest: selectedPullRequest(GitHubPRState.Merged),
    canonicalMetrics: metrics({
      idleTimeMs: overrides.idleTimeMs,
      leadTimeMs: complete(TWO_HOURS_MS),
    }),
    phaseAttribution: attribution(),
  });
}

/** Closed-unmerged, and with no phase attribution there is no outcome track. */
function tracklessClosedDetail() {
  return makeBranchDetail({
    selectedPullRequest: selectedPullRequest(GitHubPRState.Closed),
    canonicalMetrics: metrics({
      abandonmentTimeMs: complete(502_000),
      leadTimeMs: notApplicable(),
    }),
  });
}

function abandonedDetail() {
  return makeBranchDetail({
    selectedPullRequest: selectedPullRequest(GitHubPRState.Closed),
    canonicalMetrics: metrics({
      abandonmentTimeMs: complete(FIFTY_THREE_HOURS_MS),
      leadTimeMs: notApplicable(),
    }),
  });
}

function prLessDetail(
  associatedPullRequests: BranchAssociatedPullRequestCollection | undefined
) {
  return makeBranchDetail({
    associatedPullRequests,
    canonicalMetrics: metrics(),
    selectedPullRequest: null,
  });
}

function selectableCollection(): BranchAssociatedPullRequestCollection {
  return {
    items: [
      {
        id: "acme/web#42",
        repositoryFullName: "acme/web",
        number: 42,
        title: "Selectable PR",
        url: null,
        state: GitHubPRState.Open,
        isDraft: false,
        reviewDecision: null,
        openedAt: null,
        closedAt: null,
        mergedAt: null,
      },
    ],
    selectedId: null,
    selectionReason: BranchAssociatedPullRequestSelectionReason.Ambiguous,
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  };
}

function selectedPullRequest(
  state: typeof GitHubPRState.Closed | typeof GitHubPRState.Merged
): BranchSelectedPullRequestDetail {
  return {
    id: "acme/web#42",
    repositoryFullName: "acme/web",
    number: 42,
    title: "Selected PR",
    url: "https://github.com/acme/web/pull/42",
    state,
    isDraft: false,
    reviewDecision: null,
    openedAt: OPENED,
    closedAt: state === GitHubPRState.Closed ? TERMINAL : null,
    mergedAt: state === GitHubPRState.Merged ? TERMINAL : null,
    body: null,
    headRefOid: null,
    mergeCommitSha: null,
    baseRefName: null,
    authorLogin: null,
    changedFiles: null,
    additions: null,
    deletions: null,
  };
}

function metrics(
  over: {
    abandonmentTimeMs?: BranchMetricResult<number>;
    idleTimeMs?: BranchMetricResult<number>;
    leadTimeMs?: BranchMetricResult<number>;
    locPerDollar?: BranchMetricResult<number>;
  } = {}
) {
  return {
    abandonmentTimeMs: over.abandonmentTimeMs ?? unavailable(),
    idleTimeMs: over.idleTimeMs ?? complete(30 * 60 * 1000),
    leadTimeMs: over.leadTimeMs ?? unavailable(),
    locPerDollar: over.locPerDollar ?? unavailable(),
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: unavailable(),
      [BranchVisibleLifecyclePhase.Review]: unavailable(),
      [BranchVisibleLifecyclePhase.Rework]: unavailable(),
    },
    totalCostUsd: unavailable(),
  };
}

function attribution(): BranchPhaseAttributionResult {
  const segments = [
    phaseSegment(BranchVisibleLifecyclePhase.Build, "10:00", "10:30"),
    phaseSegment(BranchVisibleLifecyclePhase.Review, "10:45", "11:15"),
    phaseSegment(BranchVisibleLifecyclePhase.Rework, "11:30", "12:00"),
  ];
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
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 3,
    },
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

/** A Build phase long enough to be the ticket's own defect: 185 minutes. */
function costBreakdownDetail(overrides: { buildCostUsd?: number } = {}) {
  return makeBranchDetail({
    selectedPullRequest: selectedPullRequest(GitHubPRState.Merged),
    canonicalMetrics: {
      ...metrics(),
      phaseCostUsd: {
        [BranchVisibleLifecyclePhase.Build]: complete(
          overrides.buildCostUsd ?? 6
        ),
        [BranchVisibleLifecyclePhase.Review]: complete(3),
        [BranchVisibleLifecyclePhase.Rework]: complete(1),
      },
      totalCostUsd: complete(10),
    },
    phaseAttribution: phaseDurationAttribution(),
  });
}

function phaseDurationAttribution(): BranchPhaseAttributionResult {
  const durations: Record<BranchVisibleLifecyclePhase, number> = {
    [BranchVisibleLifecyclePhase.Build]: THREE_HOURS_FIVE_MINUTES_MS,
    [BranchVisibleLifecyclePhase.Review]: 30_000,
    [BranchVisibleLifecyclePhase.Rework]: 10_000,
  };
  return {
    segments: [],
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: durations[phase],
      sessionCount: 1,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 10,
    },
  };
}

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

function runtimeMetric(
  state: string,
  value: number
): BranchMetricResult<number> {
  return { state, value } as BranchMetricResult<number>;
}

function unavailable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}

function notApplicable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}
