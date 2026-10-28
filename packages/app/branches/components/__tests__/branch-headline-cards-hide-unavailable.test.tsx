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
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  BRANCH_CYCLE_TIME_LABEL,
  branchPullRequestCycleAbsence,
} from "@repo/app/branches/lib/branch-outcome-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { BranchHeadlineCards } from "../branch-headline-cards";

/**
 * ISS-9749 wiring the Branch detail headline strip onto ISS-9730's gate.
 *
 * Every case runs its fixture through the REAL `FeatureFlagAdapterProvider`, and
 * the shapes that must survive the hide are asserted with the gate ON — a suite
 * that only checked the hidden card would not distinguish "hides the right
 * state" from "hides everything absent".
 */
const LOC_LABEL =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.DetailLocPerDollar].label;
const LEAD_LABEL = BRANCH_METRIC_DICTIONARY[BranchMetricId.LeadTime].label;
const ABANDON_LABEL =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.AbandonmentTime].label;
/** What the lead-time card is called once the honesty key renames it. */
const CYCLE_TIME_LABEL = BRANCH_CYCLE_TIME_LABEL;

const SELECTED_PR_ID = "acme/web#42";
const NO_QUALIFYING_DATA = "No qualifying data.";
const EVIDENCE_UNAVAILABLE = "Evidence is unavailable.";
const NOT_APPLICABLE = "N/A";
/** `branchPullRequestCycleAbsence`'s reader-action arm caption. */
const SELECT_A_PULL_REQUEST = "Select a pull request to see this.";

describe("Branch detail headline cards under metric-card-hide-unavailable", () => {
  /**
   * The gate-off half of the contract: the shipped row, unchanged. This is what
   * stops every negative assertion below passing on a component that stopped
   * rendering the card for some unrelated reason.
   */
  it("renders a not-computable card with its caption when the gate is off", () => {
    renderCards({ detail: oneNoDataDetail(), hide: false });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    expect(screen.getByText(NO_QUALIFYING_DATA)).toBeInTheDocument();
    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
  });

  /**
   * The label AND the caption, not the "No data" copy: `valueUnavailableLabel`
   * is caller-overridable, so asserting the glyph alone would also pass for a
   * card that still renders its frame under a different word.
   */
  it("renders nothing at all for that card when the gate is on", () => {
    renderCards({ detail: oneNoDataDetail(), hide: true });

    expect(screen.queryByText(LOC_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_QUALIFYING_DATA)).not.toBeInTheDocument();
    // The rest of the row is untouched — the gate thins it, never empties it.
    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(ABANDON_LABEL)).toBeInTheDocument();
  });

  /**
   * The OTHER half of the not-computable classification. `isNotComputable`
   * accepts two states, and `NoData` alone is what the two cases above drive —
   * so without this case, deleting the `Unavailable` arm would leave the whole
   * suite green. It is the state the canonical projection emits for a producer
   * contradiction it CAN name, which is why it hides and the un-nameable
   * `Complete`-with-a-bad-value case below does not.
   */
  it("hides an Unavailable card too, not only a NoData one", () => {
    renderCards({ detail: oneUnavailableDetail(), hide: true });

    expect(screen.queryByText(LOC_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(EVIDENCE_UNAVAILABLE)).not.toBeInTheDocument();
    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
  });

  it("renders that same Unavailable card with the gate off", () => {
    renderCards({ detail: oneUnavailableDetail(), hide: false });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    expect(screen.getByText(EVIDENCE_UNAVAILABLE)).toBeInTheDocument();
  });

  /**
   * ISS-9749 item 3a, decided rather than inherited: `N/A` answers the question
   * — this metric does not apply to this population — and an answer is not an
   * absence.
   */
  it("keeps a not-applicable card with the gate on", () => {
    renderCards({ detail: notApplicableDetail(), hide: true });

    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(NOT_APPLICABLE)).toBeInTheDocument();
  });

  /**
   * The failed-read analogue on this surface, and the one this row would most
   * plausibly ship broken: the whole canonical bundle is missing, which is what
   * a read that did not land looks like here. ISS-9730 forbids hiding it.
   */
  it("keeps every card when the canonical bundle never arrived", () => {
    renderCards({ detail: makeBranchDetail({}), hide: true });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(ABANDON_LABEL)).toBeInTheDocument();
    expect(screen.getAllByText(EVIDENCE_UNAVAILABLE).length).toBeGreaterThan(0);
  });

  /**
   * ISS-9730 acceptance 3. A corpus where all three metrics are not computable
   * keeps today's row rather than collapsing to a bare gap.
   */
  it("keeps the whole row when every card would be hidden", () => {
    renderCards({ detail: allNoDataDetail(), hide: true });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(ABANDON_LABEL)).toBeInTheDocument();
  });

  /**
   * The same row with the honesty key ON. The all-or-nothing rule belongs to
   * the hide key alone, so both positions of the other key have to reach it —
   * and this fixture is the one that previously stopped doing so on the arm it
   * was not run on.
   */
  it("keeps that whole row with the honesty key on too", () => {
    renderCards({ detail: allNoDataDetail(), hide: true, honest: true });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    expect(screen.getByText(CYCLE_TIME_LABEL)).toBeInTheDocument();
    expect(screen.getByText(ABANDON_LABEL)).toBeInTheDocument();
  });

  /**
   * ISS-9730 acceptance 4, re-expressed rather than deleted: a producer that
   * declares `Complete` and then hands over a value the formatter refuses is a
   * defect the reader must still see. Hiding it would let the gate become a
   * route to swallowing exactly the contradiction the honesty specs exist to
   * catch — and the negative assertion pins that no number leaks either.
   */
  it("keeps a Complete result whose value will not display", () => {
    renderCards({
      detail: undisplayableCompleteDetail(),
      hide: true,
      honest: true,
    });

    expect(screen.getByText(CYCLE_TIME_LABEL)).toBeInTheDocument();
    expect(screen.getAllByText(EVIDENCE_UNAVAILABLE).length).toBeGreaterThan(0);
    expect(screen.queryByText("-1")).not.toBeInTheDocument();
  });

  /**
   * A real zero is a fact about the population, not an absence — it was never a
   * no-data state and must survive the gate with its figure intact.
   */
  it("keeps a real zero with the gate on", () => {
    renderCards({ detail: zeroLocDetail(), hide: true });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    // `formatLocPerDollar` renders a sub-10 figure at two decimals, so a real
    // zero reads "0.00" — pinned as the literal the reader actually sees.
    expect(screen.getByText("0.00")).toBeInTheDocument();
    expect(screen.queryByText(NO_QUALIFYING_DATA)).not.toBeInTheDocument();
  });

  /**
   * ISS-9749 item 3b applied to this row. "No PR selected" is an absence the
   * READER caused and can undo, and its caption is the only thing telling them
   * how; retiring the card would delete the instruction. Needs the honesty key
   * because that is what computes the pull-request reason at all.
   */
  it("keeps a card whose absence names a reader action", () => {
    renderCards({
      detail: prLessDetail(),
      hide: true,
      honest: true,
    });

    expect(screen.getByText(CYCLE_TIME_LABEL)).toBeInTheDocument();
    expect(screen.getByText(SELECT_A_PULL_REQUEST)).toBeInTheDocument();
  });

  /**
   * The SAME corpus with only the hide key on (whitlockk review on #6852).
   *
   * The two keys are independent and nothing orders them: on desktop the
   * honesty key is a local Labs toggle while this one ships through PostHog, so
   * this combination is what every desktop reader lands in the moment the hide
   * key is enabled — not an exotic pairing. The card has to survive it for the
   * same reason it survives with honesty on: the metric IS computable, it is
   * the pull-request selection that is missing, and retiring the card deletes
   * the reader's only route back to the selector. Gating the classification on
   * the honesty key made it vanish here.
   *
   * The caption is the shipped one, which is the point of the pairing with the
   * test below: the honesty key owns the WORDING, the hide key owns whether
   * there is a card at all, and this is the state where those two answers
   * differ.
   */
  it("keeps that same card when only the hide key is on", () => {
    renderCards({ detail: prLessDetail(), hide: true, honest: false });

    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(NO_QUALIFYING_DATA)).toBeInTheDocument();
  });

  /**
   * The other half of that split, so preserving the card cannot quietly start
   * publishing the honesty key's copy on a reader who never enabled it. Both
   * the caption and the label are pinned: `valueUnavailableLabel` is the second
   * string `withAbsenceReason` rewrites, so asserting only the sentence would
   * leave a half-applied restatement green.
   */
  it("leaves the reader-action wording to the honesty key", () => {
    const detail = prLessDetail();
    const absence = branchPullRequestCycleAbsence(
      detail.associatedPullRequests,
      Boolean(detail.selectedPullRequest)
    );
    if (absence === null) {
      throw new Error("prLessDetail must yield a pull-request cycle absence");
    }
    renderCards({ detail, hide: true, honest: false });

    expect(screen.queryByText(SELECT_A_PULL_REQUEST)).not.toBeInTheDocument();
    expect(screen.queryByText(absence.label)).not.toBeInTheDocument();
  });
});

function renderCards({
  detail,
  hide,
  honest = false,
}: {
  detail: ReturnType<typeof makeBranchDetail>;
  hide: boolean;
  honest?: boolean;
}) {
  const enabledFlags: string[] = [];
  if (hide) {
    enabledFlags.push(METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY);
  }
  if (honest) {
    enabledFlags.push(BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY);
  }
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <BranchHeadlineCards detail={detail} />
    </FeatureFlagAdapterProvider>
  );
}

function oneNoDataDetail() {
  return makeBranchDetail({
    canonicalMetrics: metrics({
      abandonmentTimeMs: complete(502_000),
      leadTimeMs: complete(7_200_000),
      locPerDollar: noData(),
    }),
  });
}

function oneUnavailableDetail() {
  return makeBranchDetail({
    canonicalMetrics: metrics({
      abandonmentTimeMs: complete(502_000),
      leadTimeMs: complete(7_200_000),
      locPerDollar: unavailable(),
    }),
  });
}

function allNoDataDetail() {
  return makeBranchDetail({
    // A SELECTED pull request, so all three cards really are not computable and
    // the all-or-nothing rule is what keeps the row. Without one, the bare
    // fixture has no pull-request collection at all, which is the "Pull request
    // history isn't available yet." arm — a read that did not land, which the
    // two cycle cards are then correctly kept for, leaving only ONE card not
    // computable and no all-or-nothing case to exercise. That made the case
    // vacuous under the honesty key and, once ISS-9749's classification stopped
    // depending on that key, under both.
    associatedPullRequests: selectableCollection(SELECTED_PR_ID),
    canonicalMetrics: metrics({
      abandonmentTimeMs: noData(),
      leadTimeMs: noData(),
      locPerDollar: noData(),
    }),
  });
}

function notApplicableDetail() {
  return makeBranchDetail({
    canonicalMetrics: metrics({
      abandonmentTimeMs: complete(502_000),
      leadTimeMs: notApplicable(),
      locPerDollar: complete(6),
    }),
  });
}

function undisplayableCompleteDetail() {
  return makeBranchDetail({
    // A SELECTED pull request, so the cycle-absence reason stays out of the way
    // and the card's own availability sentence is what reaches the screen.
    associatedPullRequests: selectableCollection(SELECTED_PR_ID),
    canonicalMetrics: metrics({
      abandonmentTimeMs: complete(502_000),
      leadTimeMs: complete(-1),
      locPerDollar: complete(6),
    }),
  });
}

function zeroLocDetail() {
  return makeBranchDetail({
    canonicalMetrics: metrics({
      abandonmentTimeMs: complete(502_000),
      leadTimeMs: complete(7_200_000),
      locPerDollar: complete(0),
    }),
  });
}

function prLessDetail() {
  return makeBranchDetail({
    associatedPullRequests: selectableCollection(null),
    canonicalMetrics: metrics({
      // Only the cycle card goes absent, so the reader-action caption below has
      // exactly one card to belong to.
      abandonmentTimeMs: complete(502_000),
      leadTimeMs: noData(),
      locPerDollar: complete(6),
    }),
    selectedPullRequest: null,
  });
}

function selectableCollection(
  selectedId: string | null
): BranchAssociatedPullRequestCollection {
  return {
    completeness: {
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      reasons: [],
      state: BranchAssociatedPullRequestCompletenessState.Complete,
    },
    items: [
      {
        closedAt: null,
        id: SELECTED_PR_ID,
        isDraft: false,
        mergedAt: null,
        number: 42,
        openedAt: null,
        repositoryFullName: "acme/web",
        reviewDecision: null,
        state: GitHubPRState.Open,
        title: "Selectable PR",
        url: null,
      },
    ],
    selectedId,
    selectionReason: BranchAssociatedPullRequestSelectionReason.Ambiguous,
  };
}

function metrics(over: {
  abandonmentTimeMs: BranchMetricResult<number>;
  leadTimeMs: BranchMetricResult<number>;
  locPerDollar: BranchMetricResult<number>;
}) {
  return {
    abandonmentTimeMs: over.abandonmentTimeMs,
    idleTimeMs: unavailable(),
    leadTimeMs: over.leadTimeMs,
    locPerDollar: over.locPerDollar,
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: unavailable(),
      [BranchVisibleLifecyclePhase.Review]: unavailable(),
      [BranchVisibleLifecyclePhase.Rework]: unavailable(),
    },
    totalCostUsd: unavailable(),
  };
}

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

function noData(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NoData, value: null };
}

function notApplicable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}

function unavailable(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}
