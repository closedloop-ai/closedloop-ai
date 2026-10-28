import type { SummaryAggregate } from "@repo/api/src/utils/agent-component-summary-aggregate";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentsSummaryCards } from "../agents-summary-cards";

/**
 * ISS-9749 wiring the Agents workspace summary strip onto ISS-9730's gate.
 *
 * Only the LOC/$ card can be genuinely absent here: its three rowmates are
 * formatted counts that always exist. So every case runs with the gate ON, and
 * the ones that must SURVIVE it carry the weight — a suite that only checked
 * the hidden card could not tell "hides the right state" from "hides anything
 * that looks empty".
 */
const COMPONENTS_LABEL = "Components";
const INVOCATIONS_LABEL = "Invocations";
const UNAVAILABLE_DETAIL = "Unavailable";
const LOADING_DETAIL = "Loading…";

describe("Agents summary cards under metric-card-hide-unavailable", () => {
  it("retires the LOC/$ card and keeps its three rowmates", () => {
    renderCards({ current: aggregate(null), hide: true });

    expect(screen.queryByText(LOC_PER_DOLLAR_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(KPI_NO_VALUE)).not.toBeInTheDocument();
    expect(screen.getByText(COMPONENTS_LABEL)).toBeInTheDocument();
    expect(screen.getByText(INVOCATIONS_LABEL)).toBeInTheDocument();
    expect(screen.getByText(AGENT_COMPONENT_AUTHORS_LABEL)).toBeInTheDocument();
  });

  /**
   * The case that fails if the hide is ever keyed off falsiness rather than
   * absence: a real `0` is a measured fact about the population — the ratio of
   * sums came out zero — and `formatLocPerDollar` renders it "0.00".
   */
  it("keeps a real zero with the gate on", () => {
    renderCards({ current: aggregate(0), hide: true });

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.getByText("0.00")).toBeInTheDocument();
    expect(screen.queryByText(KPI_NO_VALUE)).not.toBeInTheDocument();
  });

  /**
   * A non-finite ratio is a CORRUPT producer value, not a settled successful
   * absence. Retiring it would delete the reader's only signal that the number
   * arrived malformed, so the card keeps its dash (davetho review on #6914).
   */
  it("keeps a non-finite ratio visible", () => {
    renderCards({ current: aggregate(Number.POSITIVE_INFINITY), hide: true });

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.getByText(KPI_NO_VALUE)).toBeInTheDocument();
  });

  it("keeps a NaN ratio visible too", () => {
    renderCards({ current: aggregate(Number.NaN), hide: true });

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.getByText(KPI_NO_VALUE)).toBeInTheDocument();
  });

  /**
   * The failed-read strip. `current` holds the same empty aggregate the loading
   * strip does, so hiding on it would delete the reader's only signal above the
   * "Couldn't load components" region.
   */
  it("keeps every card of the failed-read strip", () => {
    renderCards({ current: emptyAggregate(), hide: true, isError: true });

    expect(screen.getByText(COMPONENTS_LABEL)).toBeInTheDocument();
    expect(screen.getByText(INVOCATIONS_LABEL)).toBeInTheDocument();
    expect(screen.getByText(AGENT_COMPONENT_AUTHORS_LABEL)).toBeInTheDocument();
    expect(screen.getAllByText(UNAVAILABLE_DETAIL)).toHaveLength(3);
  });

  /** The still-loading strip: the number is coming, so the card stays. */
  it("keeps every card of the loading strip", () => {
    renderCards({ current: emptyAggregate(), hide: true, isLoading: true });

    expect(screen.getByText(COMPONENTS_LABEL)).toBeInTheDocument();
    expect(screen.getByText(INVOCATIONS_LABEL)).toBeInTheDocument();
    expect(screen.getByText(AGENT_COMPONENT_AUTHORS_LABEL)).toBeInTheDocument();
    expect(screen.getAllByText(LOADING_DETAIL)).toHaveLength(3);
  });

  /**
   * The gate-off half of the contract: the shipped row, dash and all. Without
   * it the negative assertions above would also pass on a strip that stopped
   * rendering the LOC/$ card for some unrelated reason.
   */
  it("renders the absent LOC/$ card with the gate off", () => {
    renderCards({ current: aggregate(null), hide: false });

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.getByText(KPI_NO_VALUE)).toBeInTheDocument();
    expect(screen.getByText(COMPONENTS_LABEL)).toBeInTheDocument();
  });
});

function renderCards({
  current,
  hide,
  isError = false,
  isLoading = false,
}: {
  current: SummaryAggregate;
  hide: boolean;
  isError?: boolean;
  isLoading?: boolean;
}) {
  // ISS-9931: the unsettled strip the two honesty cases are about renders on
  // `isLoading`/`isError` alone, so no gate is seeded for it here.
  const enabledFlags: string[] = [];
  if (hide) {
    enabledFlags.push(METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY);
  }
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <AgentsSummaryCards
        current={current}
        dedupePluginRollups={false}
        isError={isError}
        isLoading={isLoading}
      />
    </FeatureFlagAdapterProvider>
  );
}

function aggregate(locPerDollar: number | null): SummaryAggregate {
  return {
    collaborators: 7,
    components: 42,
    hasVerifiableLocPerDollar: true,
    invocations: 310,
    invocationsExact: true,
    invocationsPluginCoverage: new Map(),
    locPerDollar,
    locPerDollarSampleSize: locPerDollar === null ? 0 : 23,
  };
}

function emptyAggregate(): SummaryAggregate {
  return {
    collaborators: 0,
    components: 0,
    hasVerifiableLocPerDollar: false,
    invocations: 0,
    invocationsExact: true,
    invocationsPluginCoverage: new Map(),
    locPerDollar: null,
    locPerDollarSampleSize: 0,
  };
}
