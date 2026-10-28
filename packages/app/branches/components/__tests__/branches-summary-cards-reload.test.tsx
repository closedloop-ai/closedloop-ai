import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { SessionsSummaryCardsLoading } from "@repo/app/agents/components/sessions/sessions-summary-cards-loading";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "../../lib/branches-summary-honest-loading-flag";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";
import { BranchesSummaryCards } from "../branches-summary-cards";

/**
 * ISS-9887. Branches held the OUTGOING window's analytics on screen while the
 * new window loaded (`keepPreviousData`) and nothing in its pending decision saw
 * that, so the strip re-stated the previous population's KPI values as current.
 * Sessions, on the identical query shape, folded `isPlaceholderData` into its
 * loading gate (FEA-4177) and skeletoned instead.
 *
 * The decisive case is therefore a RELOAD, not a first load: with no bundle in
 * hand there is nothing to lie with, and a first-load test passes against the
 * defect. Every case below holds a settled bundle and varies only whether the
 * read is serving the scope the reader is actually looking at.
 */

const SKELETON = '[data-slot="skeleton"]';
const CARD = '[data-slot="card"]';
const BUSY_ROW = '[aria-busy="true"]';
const BRANCH_CARD_COUNT = 5;
/** A comparing shell skeletons its value slot and its comparison slot. */
const SKELETONS_PER_COMPARING_CARD = 2;
const FAILED_READ_CAPTION = "Unavailable";

/** A bundle whose Active branches card carries a real, settled number. */
function metricsWithActiveBranches(value: number) {
  return makeBranchListMetrics({
    activeBranches: {
      current: { state: BranchMetricAvailability.Complete, value },
    },
  });
}

function renderApproved(
  props: Partial<ComponentProps<typeof ApprovedBranchesSummaryCards>>,
  {
    honestLoading,
    hideUnavailable = false,
  }: { honestLoading: boolean; hideUnavailable?: boolean }
) {
  const enabledFlags = [
    ...(honestLoading
      ? [BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY]
      : []),
    ...(hideUnavailable ? [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY] : []),
  ];
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={metricsWithActiveBranches(12)}
        reservesPendingComparisonSlot
        {...props}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("Branches summary cards during a reload (ISS-9887)", () => {
  it("does not state the previous scope's figures as current while reloading", () => {
    const { container } = renderApproved(
      { isReloading: true },
      {
        honestLoading: true,
      }
    );

    // The held figure is gone, and the row says so rather than going blank.
    expect(screen.queryByText("12")).toBeNull();
    expect(container.querySelector(BUSY_ROW)).not.toBeNull();
    expect(container.querySelectorAll(SKELETON)).toHaveLength(
      BRANCH_CARD_COUNT * SKELETONS_PER_COMPARING_CARD
    );
    // NOT the failed-read treatment: a reload is not a breakage, and captioning
    // it "Unavailable" would spend the word this row reserves for a real one.
    expect(screen.queryByText(FAILED_READ_CAPTION)).toBeNull();
    expect(screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL)).toHaveLength(
      BRANCH_CARD_COUNT
    );
  });

  it("states the same figure once the read is serving this scope", () => {
    // The positive control for the assertion above: the identical props with
    // the reload signal cleared DO print `12`, so its absence above is the
    // reload treatment and not a fixture that renders nothing.
    const { container } = renderApproved(
      { isReloading: false },
      {
        honestLoading: true,
      }
    );

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(container.querySelector(SKELETON)).toBeNull();
    expect(container.querySelector(BUSY_ROW)).toBeNull();
  });

  it("leaves the reload signal inert while the gate is closed", () => {
    // ISS-4779 closed-by-default. Nothing about a reload may reach a reader
    // whose `branches-summary-honest-loading` assignment is off, including the
    // skeleton — flag OFF is byte-for-byte the shipped strip.
    const { container } = renderApproved(
      { isReloading: true },
      {
        honestLoading: false,
      }
    );

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(container.querySelector(SKELETON)).toBeNull();
    expect(container.querySelector(BUSY_ROW)).toBeNull();
  });
});

describe("Branches summary cards keep four states distinct (ISS-9887)", () => {
  it("skeletons a wait", () => {
    const { container } = renderApproved(
      { isReloading: true },
      {
        honestLoading: true,
      }
    );

    expect(container.querySelector(SKELETON)).not.toBeNull();
  });

  it("keeps a failed read visible rather than skeletoning it away", () => {
    // A failed read is not an empty card. It is NOT an absence, and it outranks
    // the wait: a refetch is in flight for the failed scope here, over a warm
    // cache, and every wrong answer is available — shimmer over it, blank it,
    // call it "No data", or go on printing the held figure as current.
    const { container } = renderApproved(
      { isError: true, isReloading: true },
      { honestLoading: true }
    );

    // Not a wait…
    expect(container.querySelector(SKELETON)).toBeNull();
    expect(screen.queryByText(LIST_SUMMARY_LOADING_DETAIL)).toBeNull();
    // …not the held figure restated as current…
    expect(screen.queryByText("12")).toBeNull();
    // …not blank, and not gone: all shipped cards are still on screen, each
    // reading as failed rather than as a population with nothing in it.
    expect(container.querySelectorAll(CARD)).toHaveLength(BRANCH_CARD_COUNT);
    expect(screen.getAllByText(FAILED_READ_CAPTION)).toHaveLength(
      BRANCH_CARD_COUNT
    );
    expect(screen.queryByText("No data")).toBeNull();
  });

  it("never hides a failed read, even with the hide gate also on", () => {
    // `metric-card-hide-unavailable` exists for the NOT-COMPUTABLE state alone.
    // Both gates on is the case neither gate's own suite exercises, and it is
    // the one where a failed read could vanish: the row would have to decide
    // the failure is an absence to hide it.
    const { container } = renderApproved(
      { isError: true, isReloading: true },
      { hideUnavailable: true, honestLoading: true }
    );

    expect(container.querySelectorAll(CARD)).toHaveLength(BRANCH_CARD_COUNT);
    expect(screen.getAllByText(FAILED_READ_CAPTION)).toHaveLength(
      BRANCH_CARD_COUNT
    );
  });

  it("still hides a not-computable metric with that gate on, so the guard bites", () => {
    // The positive control for the test above: with the same gate on, the state
    // the gate DOES own really is retired. Without this, "five cards survived"
    // would also pass against a gate that had silently stopped working.
    //
    // Two cards survive the hide pass: the Complete one, plus LOC per $, which
    // ISS-9958 marks `neverHidden`. `hiddenMetricCardIds` is all-or-nothing, so
    // a row where EVERY card is not computable would render in full instead
    // (ISS-9749).
    const { container } = renderApproved(
      { isReloading: false, metrics: metricsWithActiveBranches(12) },
      { hideUnavailable: true, honestLoading: true }
    );

    expect(container.querySelectorAll(CARD)).toHaveLength(2);
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("keeps a not-computable metric on its own no-data treatment", () => {
    const { container } = renderApproved(
      {
        isReloading: false,
        metrics: makeBranchListMetrics({
          activeBranches: {
            current: { state: BranchMetricAvailability.NoData, value: null },
          },
        }),
      },
      { honestLoading: true }
    );

    expect(container.querySelector(SKELETON)).toBeNull();
    // Its own cause, not the failed-read word and not a shimmer.
    expect(screen.getAllByText("No data").length).toBeGreaterThan(0);
  });

  it("prints a real zero, because zero is a fact about the population", () => {
    const { container } = renderApproved(
      { isReloading: false, metrics: metricsWithActiveBranches(0) },
      { honestLoading: true }
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(container.querySelector(SKELETON)).toBeNull();
  });
});

describe("Branches and Sessions load through one strip (ISS-9887)", () => {
  /**
   * Both rows render `SummaryMetricsLoadingRow`, so the two loading strips share
   * one GEOMETRY: one busy row, one `MetricCard` shell per card, and a shimmer
   * in every value slot (plus the reserved comparison slot when the host
   * compares). That is what these counts pin, and it is the part that decides
   * whether the strip settles without moving.
   *
   * It is NOT a claim that the two trees are identical, and it cannot detect a
   * second implementation on its own — three cardinalities can't. The trees
   * genuinely differ: Branches gives every shell an `info` popover and Sessions
   * gives none, so the Branches strip carries five info triggers the Sessions
   * strip does not. That difference is asserted explicitly below rather than
   * left for these counts to miss.
   */
  function loadingShape(container: HTMLElement) {
    return {
      busy: container.querySelectorAll(BUSY_ROW).length,
      cards: container.querySelectorAll(CARD).length,
      skeletons: container.querySelectorAll(SKELETON).length,
    };
  }

  /** The known, intended per-surface difference: Branches captions its shells. */
  function infoTriggerCount(container: HTMLElement) {
    return container.querySelectorAll("button[aria-haspopup]").length;
  }

  it("skeletons the Branches strip and the Sessions strip identically", () => {
    const { container: branches } = renderApproved(
      { isReloading: true },
      {
        honestLoading: true,
      }
    );
    const { container: sessions } = render(
      <SessionsSummaryCardsLoading
        cardClassName="card"
        loadingDetail="Loading…"
        locPerDollarLabel="LOC / $"
        reservesDeltaSlot
      />
    );

    expect(loadingShape(branches)).toEqual(loadingShape(sessions));
    expect(loadingShape(branches)).toEqual({
      busy: 1,
      cards: BRANCH_CARD_COUNT,
      skeletons: BRANCH_CARD_COUNT * SKELETONS_PER_COMPARING_CARD,
    });
    // The one place the trees are meant to diverge, stated rather than implied:
    // Branches keeps each shell's info popover, Sessions ships none.
    expect(infoTriggerCount(branches)).toBe(BRANCH_CARD_COUNT);
    expect(infoTriggerCount(sessions)).toBe(0);
  });

  it("reserves no comparison slot on either strip when the host does not compare", () => {
    const { container: branches } = renderApproved(
      { isReloading: true, reservesPendingComparisonSlot: false },
      { honestLoading: true }
    );
    const { container: sessions } = render(
      <SessionsSummaryCardsLoading
        cardClassName="card"
        loadingDetail="Loading…"
        locPerDollarLabel="LOC / $"
        reservesDeltaSlot={false}
      />
    );

    expect(loadingShape(branches)).toEqual(loadingShape(sessions));
    expect(loadingShape(branches).skeletons).toBe(BRANCH_CARD_COUNT);
  });

  /**
   * Every case above renders `ApprovedBranchesSummaryCards` directly, which
   * skips the seam both hosts actually mount. Measured: replacing
   * `isReloading={isReloading}` with `isReloading={false}` in
   * `branches-summary-cards.tsx` left all 602 tests in `branches/components`
   * green. The reload contract was pinned and its only production route to the
   * page was not, which is the shape a deleted pass-through ships through.
   */
  it("forwards the host's reloading signal through the shared seam", () => {
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY],
        })}
      >
        <BranchesSummaryCards
          analytics={
            {
              canonicalMetrics: metricsWithActiveBranches(12),
            } as ComponentProps<typeof BranchesSummaryCards>["analytics"]
          }
          approvedReservesDeltaSlot
          isError={false}
          isPending={false}
          isReloading
        />
      </FeatureFlagAdapterProvider>
    );

    expect(container.querySelectorAll(BUSY_ROW)).toHaveLength(1);
    expect(screen.queryByText("12")).toBeNull();
  });
});
