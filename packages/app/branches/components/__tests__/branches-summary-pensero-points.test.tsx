/**
 * ISS-11117 — the Branches listing row renders `Pts / $` from the Pensero
 * numerator, and renders LOC/$ unchanged when there is none.
 *
 * This drives the PRODUCTION row rather than the resolver: deleting the
 * resolver's wiring out of `ApprovedBranchesSummaryCards` must turn these red,
 * which a lib-only test would not notice.
 */
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

const LOC_CARD_LABEL = "LOC per $";
const POINTS_CARD_LABEL = "Pts / $";

describe("ISS-11117 Branches listing Pts / $", () => {
  it("renders the points figure UNDER the points label", () => {
    renderRow(
      metrics({
        penseroPointsPerDollar: {
          current: {
            state: BranchMetricAvailability.Partial,
            value: 12.34,
            disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
          },
        },
      })
    );

    // The PAIR. Either half alone would stay green while the other went wrong,
    // which is the drift the one-resolver rule exists to prevent.
    const card = cardLabelled(POINTS_CARD_LABEL);
    expect(card.textContent).toContain("12.3 Pts/$");
    expect(card.textContent).toContain("points delivered per dollar");
    // The LOC card is not rendered beside it — one per-dollar card, swapped.
    expect(screen.queryByText(LOC_CARD_LABEL)).toBeNull();
  });

  it("renders LOC/$ with its LOC label when no numerator is published", () => {
    // AC2, positively: the number the reader can already see stays, under the
    // word it has always carried.
    renderRow(metrics());

    const card = cardLabelled(LOC_CARD_LABEL);
    expect(card.textContent).toContain("7.5 LOC/$");
    expect(card.textContent).toContain("lines changed per dollar");
    expect(screen.queryByText(POINTS_CARD_LABEL)).toBeNull();
  });

  it("renders LOC/$ when a Pensero field arrives UNPUBLISHABLE", () => {
    renderRow(
      metrics({
        penseroPointsPerDollar: {
          current: { state: BranchMetricAvailability.Unavailable, value: null },
        },
      })
    );

    expect(cardLabelled(LOC_CARD_LABEL).textContent).toContain("7.5 LOC/$");
    expect(screen.queryByText(POINTS_CARD_LABEL)).toBeNull();
  });
});

function complete(value: number) {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  } as const;
}

function metrics(overrides: Parameters<typeof makeBranchListMetrics>[0] = {}) {
  return makeBranchListMetrics({
    activeBranches: complete(3),
    medianPrSize: complete(120),
    mergeRatePct: complete(50),
    aiSpendUsd: complete(100),
    locPerDollar: complete(1.5),
    pushedLocPerDollar: complete(4.25),
    canonicalLocPerDollar: complete(7.5),
    totalLocPushed: complete(850),
    ...overrides,
  });
}

function renderRow(bundle: ReturnType<typeof makeBranchListMetrics>) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={bundle}
      />
    </FeatureFlagAdapterProvider>
  );
}

function cardLabelled(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`card labelled ${label} is missing`);
  }
  return card;
}
