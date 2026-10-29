import type { ComponentModelTrendResponse } from "@repo/api/src/types/agent-component";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptimizationAnalyticsPanel } from "../optimization-analytics-panel";

/**
 * ISS-10691: a literal-text assertion cannot tell a live flag read from a
 * hardcoded header, so the whole file stubs the vocabulary module with a
 * sentinel no surface could hardcode. That is what makes deleting the read
 * redden it.
 *
 * What that buys and what it does not: these cases pin that the header resolves
 * the vocabulary module behind the flag. They do NOT pin the canonical phrase's
 * own spelling — `total-estimated-cost-single-owner.test.ts` owns that.
 */

// Both are read inside the `vi.mock` factory, which runs before a plain
// module-level const has initialized.
const { CANONICAL_SENTINEL_LABEL, LEGACY_TREND_COST_LABEL } = vi.hoisted(
  () => ({
    CANONICAL_SENTINEL_LABEL: "sentinel-canonical-no-surface-can-hardcode",
    LEGACY_TREND_COST_LABEL: "Cost",
  })
);

vi.mock("@repo/api/src/types/total-estimated-cost-copy", () => ({
  TOTAL_ESTIMATED_COST_ALIAS_LABEL: LEGACY_TREND_COST_LABEL,
  TOTAL_ESTIMATED_COST_COPY: {
    info: { how: "test how.", what: "test what." },
    label: CANONICAL_SENTINEL_LABEL,
    shortLabel: LEGACY_TREND_COST_LABEL,
  },
  TOTAL_ESTIMATED_COST_LABEL: CANONICAL_SENTINEL_LABEL,
}));

function makeTrend(): ComponentModelTrendResponse {
  return {
    componentKey: "bug-hunter",
    componentKind: "subagent",
    points: [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        compactionCount: 0,
        day: "2026-07-10",
        estimatedCostUsd: 1.23,
        inputTokens: 1000,
        latencyAvgMs: 500,
        latencyMaxMs: 900,
        model: "claude-opus-4-5",
        outputTokens: 200,
      },
    ],
    windowDays: 30,
  };
}

function renderWithFlag(enabled: boolean) {
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    db: {
      getComponentModelTrend: vi.fn().mockResolvedValue(makeTrend()),
      getSubagentFrequency: vi.fn().mockResolvedValue({
        points: [],
        subagentKey: "bug-hunter",
        windowDays: 30,
      }),
    },
  };
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [ONE_LABEL_PER_METRIC_FLAG_KEY] : [],
      })}
    >
      <OptimizationAnalyticsPanel
        target={{ key: "bug-hunter", kind: "subagent", name: "Bug Hunter" }}
      />
    </FeatureFlagAdapterProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
});

describe("model trend cost column label", () => {
  it("resolves the canonical phrase from the vocabulary with the gate on", async () => {
    renderWithFlag(true);

    await waitFor(() =>
      expect(screen.getByTestId("model-trend-card")).toBeDefined()
    );
    expect(
      screen.getByRole("columnheader", { name: CANONICAL_SENTINEL_LABEL })
    ).toBeDefined();
    expect(
      screen.queryByRole("columnheader", { name: LEGACY_TREND_COST_LABEL })
    ).toBeNull();
  });

  it("keeps the legacy literal with the gate off", async () => {
    renderWithFlag(false);

    await waitFor(() =>
      expect(screen.getByTestId("model-trend-card")).toBeDefined()
    );
    expect(
      screen.getByRole("columnheader", { name: LEGACY_TREND_COST_LABEL })
    ).toBeDefined();
    expect(
      screen.queryByRole("columnheader", { name: CANONICAL_SENTINEL_LABEL })
    ).toBeNull();
  });
});
