/**
 * ISS-10021 — the Branches row's LOC per $ reads
 * `BranchListMetricBundle.canonicalLocPerDollar` as a whole CARD shape: its own
 * id and its own copy, not a number swapped under another card's sentence.
 *
 * ISS-10021 was drafted to move that read behind `total-estimated-cost-metrics`,
 * on the premise that #7021 had made it unconditional by accident; ISS-9970
 * (#7066) then landed on `main` and made it unconditional deliberately — one
 * dollar basis. ISS-10636 has since retired the gate outright, so every case
 * below renders with NO flag seeded (AC-5), which is the only state left.
 */
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

const RATIO_CARD_LABEL = "LOC per $";

function complete(value: number) {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  } as const;
}

/** Three distinct ratios, so the DOM says which field the card selected. */
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

function ratioCard(): HTMLElement {
  const card = screen.getByText(RATIO_CARD_LABEL).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error("ratio card is missing");
  }
  return card;
}

describe("ISS-10021 LOC per $ on the canonical basis", () => {
  it("renders canonicalLocPerDollar", () => {
    renderRow(metrics());
    expect(ratioCard()).toHaveTextContent("7.5 LOC/$");
  });

  it("degrades to the pushed ratio when a producer omits the canonical field", () => {
    renderRow(metrics({ canonicalLocPerDollar: undefined }));
    expect(ratioCard()).toHaveTextContent("4.25 LOC/$");
  });

  it("describes the total-estimated-cost basis in its copy", async () => {
    const user = userEvent.setup();
    renderRow(metrics());
    await user.click(
      screen.getByRole("button", { name: `About ${RATIO_CARD_LABEL}` })
    );
    const dialog = await screen.findByRole("dialog", {
      name: `About ${RATIO_CARD_LABEL}`,
    });
    expect(dialog).toHaveTextContent(TOTAL_ESTIMATED_COST_LABEL.toLowerCase());
    expect(dialog).not.toHaveTextContent("global Branch divisor");
  });
});
