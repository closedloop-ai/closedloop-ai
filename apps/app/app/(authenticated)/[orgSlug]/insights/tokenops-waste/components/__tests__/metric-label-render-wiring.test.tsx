import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import type { ModelRightSizingRow } from "@repo/api/src/types/session-analytics";
import { ModelVerdict } from "@repo/api/src/types/session-analytics";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelRightSizing } from "../model-right-sizing";
import { WidgetState } from "../widget-state";

/**
 * ISS-10691: renders the real component through the real feature-flag port, so
 * deleting the flag read reddens this file rather than leaving it green. The
 * legacy word and the canonical phrase are different strings here, so a plain
 * text assertion tells a live read from a hardcoded one.
 */

const LEGACY_SPEND_LABEL = "Spend";

const ROW: ModelRightSizingRow = {
  confidencePct: 80,
  errorOutcomeUsd: 1,
  medianTokens: 1000,
  medianWorkTokens: 800,
  model: "claude-opus-4-5",
  sessions: 12,
  usd: 42,
  usdPerSession: 3.5,
  verdict: ModelVerdict.RightSized,
};

function renderWithFlag(enabled: boolean) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [ONE_LABEL_PER_METRIC_FLAG_KEY] : [],
      })}
    >
      <ModelRightSizing
        minGradedSessions={undefined}
        models={[ROW]}
        state={WidgetState.Ready}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("model right-sizing cost column label", () => {
  it("renders the canonical phrase with the gate on", () => {
    renderWithFlag(true);
    expect(
      screen.getByRole("columnheader", { name: TOTAL_ESTIMATED_COST_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: LEGACY_SPEND_LABEL })
    ).toBeNull();
  });

  it("keeps the legacy word with the gate off", () => {
    renderWithFlag(false);
    expect(
      screen.getByRole("columnheader", { name: LEGACY_SPEND_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: TOTAL_ESTIMATED_COST_LABEL })
    ).toBeNull();
  });
});
