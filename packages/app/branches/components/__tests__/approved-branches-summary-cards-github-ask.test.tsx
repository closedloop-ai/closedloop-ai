import {
  BranchMetricAvailability,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { METRIC_CARD_NO_DATA_LABEL } from "@repo/design-system/components/ui/primitives/metric-card";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BRANCH_METRIC_UNAVAILABLE_DETAIL } from "../approved-branch-metric-card";
import {
  ApprovedBranchesSummaryCards,
  BRANCHES_SUMMARY_CANONICAL_CARD_SPECS,
} from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/**
 * ISS-12638 (operator ruling): a Branches summary card the producer could not
 * compute asks the host's connect target in place of its Unavailable caption.
 *
 * marisolashgrove's review added the discipline the first implementation lacked:
 * the ask is keyed on whether a GitHub connection PRODUCES that card's evidence
 * (`CardSpec.gitHubTruth`), never on the availability bucket, which five
 * different shortfalls share. So the cards GitHub has no part in keep their own
 * caption on the same strip, in the same state, with a target passed. The other
 * half of his finding — the local fallback's absences, which a connect cannot
 * fix either — is withheld a layer up and pinned by
 * `apps/desktop/.../branches-summary-connect-ask.test.ts`.
 */

const CONNECT_COPY = GITHUB_CONNECT_COPY[GitHubConnectAction.Connect];
const CONNECT_CTA = CONNECT_COPY.cardCtaLabel ?? CONNECT_COPY.ctaLabel;
const CARD_COUNT = BRANCHES_SUMMARY_CANONICAL_CARD_SPECS.length;
/**
 * Derived from the specs rather than written out, so adding a card to the strip
 * cannot leave these counts quietly describing the old row.
 */
const GITHUB_TRUTH_CARD_COUNT = BRANCHES_SUMMARY_CANONICAL_CARD_SPECS.filter(
  (card) => card.gitHubTruth === true
).length;
const PLAIN_CARD_COUNT = CARD_COUNT - GITHUB_TRUTH_CARD_COUNT;

type StripState = {
  isError: boolean;
  isPending: boolean;
  withMetrics: boolean;
};

const COMPUTED_STATE: StripState = {
  isError: false,
  isPending: false,
  withMetrics: true,
};

function renderStrip(withAsk: boolean, state: StripState) {
  render(
    <ApprovedBranchesSummaryCards
      cardClassName=""
      githubConnect={
        withAsk
          ? { action: GitHubConnectAction.Connect, onConnect: vi.fn() }
          : undefined
      }
      isError={state.isError}
      isPending={state.isPending}
      metrics={state.withMetrics ? makeBranchListMetrics() : undefined}
    />
  );
}

describe("Branches summary strip connect ask (ISS-12638)", () => {
  // The counts below are derived from the flag production reads, so setting it
  // on another card would move them together. This names the cards (operator,
  // 2026-10-21: Active branches and Total LOC pushed do not ask).
  it("names the cards that ask, independent of the counts below", () => {
    const asking = BRANCHES_SUMMARY_CANONICAL_CARD_SPECS.filter(
      (card) => card.gitHubTruth === true
    )
      .map((card) => card.id)
      .sort();

    expect(asking).toEqual(
      [
        BranchMetricId.CanonicalLocPerDollar,
        BranchMetricId.MedianPrSize,
        BranchMetricId.MergeRate,
      ].sort()
    );
  });

  it("asks only on the cards a GitHub connection produces", () => {
    renderStrip(true, COMPUTED_STATE);

    // The fixture leaves every card Unavailable, so the split below is the
    // per-card gate and nothing else about the data.
    expect(GITHUB_TRUTH_CARD_COUNT).toBeGreaterThan(0);
    expect(PLAIN_CARD_COUNT).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: CONNECT_CTA })).toHaveLength(
      GITHUB_TRUTH_CARD_COUNT
    );
    expect(screen.getAllByText(METRIC_CARD_NO_DATA_LABEL)).toHaveLength(
      GITHUB_TRUTH_CARD_COUNT
    );
  });

  it("leaves a card GitHub has no part in on its own Unavailable caption", () => {
    renderStrip(true, COMPUTED_STATE);

    // Active branches says so in its own popover: no live GitHub request is made
    // for it. Total LOC pushed is push evidence, not merged-PR evidence.
    expect(screen.getAllByText(BRANCH_METRIC_UNAVAILABLE_DETAIL)).toHaveLength(
      PLAIN_CARD_COUNT
    );
  });

  it("shows a failed read as the error it is, with no ask", () => {
    renderStrip(true, { ...COMPUTED_STATE, isError: true, withMetrics: false });

    expect(screen.getAllByText(BRANCH_METRIC_UNAVAILABLE_DETAIL)).toHaveLength(
      CARD_COUNT
    );
    expect(
      screen.queryByRole("button", { name: CONNECT_CTA })
    ).not.toBeInTheDocument();
  });

  it("asks nothing while the read is pending", () => {
    renderStrip(true, {
      ...COMPUTED_STATE,
      isPending: true,
      withMetrics: false,
    });

    expect(
      screen.queryByRole("button", { name: CONNECT_CTA })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(METRIC_CARD_NO_DATA_LABEL)
    ).not.toBeInTheDocument();
  });

  it("keeps the Unavailable caption on every card when the host offers no ask", () => {
    renderStrip(false, COMPUTED_STATE);

    expect(screen.getAllByText(BRANCH_METRIC_UNAVAILABLE_DETAIL)).toHaveLength(
      CARD_COUNT
    );
    expect(
      screen.queryByRole("button", { name: CONNECT_CTA })
    ).not.toBeInTheDocument();
  });

  it("leaves a computed card on its value", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName=""
        githubConnect={{
          action: GitHubConnectAction.Connect,
          onConnect: vi.fn(),
        }}
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: {
            current: { state: BranchMetricAvailability.Complete, value: 42 },
          },
        })}
      />
    );

    expect(screen.getByText("42 LOC")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: CONNECT_CTA })).toHaveLength(
      GITHUB_TRUTH_CARD_COUNT - 1
    );
  });
});
