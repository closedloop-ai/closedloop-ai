import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
} from "../sessions-summary-card-labels";
import { SessionsSummaryCardId } from "../sessions-summary-card-visibility";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * ISS-9749 wiring the Sessions strip onto ISS-9730's gate, with the delivery
 * pair SETTLED (signed in, GitHub connected, no error) — the only state in
 * which the gate may retire either of them.
 */
describe("Sessions summary cards under metric-card-hide-unavailable", () => {
  it("retires the delivery card whose count never arrived", () => {
    renderStrip({ hide: true, usage: usageFixture({ mergedPrCount: null }) });

    expect(
      screen.queryByText(PRS_SHIPPED_METRIC_CARD_LABEL)
    ).not.toBeInTheDocument();
    expect(screen.getByText(SESSIONS_METRIC_CARD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
  });

  /**
   * The same card with the gate off — without it the assertion above would also
   * pass on a strip that stopped rendering the card for an unrelated reason.
   */
  it("keeps that same card with the gate off", () => {
    renderStrip({ hide: false, usage: usageFixture({ mergedPrCount: null }) });

    expect(screen.getByText(PRS_SHIPPED_METRIC_CARD_LABEL)).toBeInTheDocument();
  });

  it("keeps a real zero, which is a fact about the population", () => {
    renderStrip({ hide: true, usage: usageFixture({ mergedPrCount: 0 }) });

    expect(screen.getByText(PRS_SHIPPED_METRIC_CARD_LABEL)).toBeInTheDocument();
  });

  /**
   * CORRUPT IS NOT ABSENT. A non-finite count is malformed producer output, not
   * a successful read of an empty population; retiring it would delete the
   * reader's only evidence that the metric arrived broken (davetho review on
   * #6914). Reddens the moment non-finite is folded back into the absent set.
   */
  it("keeps a non-finite merged-PR count visible", () => {
    renderStrip({
      hide: true,
      usage: usageFixture({ mergedPrCount: Number.NaN }),
    });

    expect(screen.getByText(PRS_SHIPPED_METRIC_CARD_LABEL)).toBeInTheDocument();
  });

  it("retires a non-finite LOC/$ ratio when another visible card survives", () => {
    renderStrip({
      hide: true,
      usage: usageFixture({
        mergedLocPerDollar: Number.POSITIVE_INFINITY,
      }),
    });

    expect(screen.queryByText(LOC_PER_DOLLAR_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(PRS_SHIPPED_METRIC_CARD_LABEL)).toBeInTheDocument();
  });

  /**
   * ISS-9730 acceptance 3, measured against the row AS PAINTED. The reader has
   * already hidden Sessions, Total Tokens and Cost, so the two delivery cards
   * are the whole visible strip; both being absent would retire it entirely, so
   * the gate retires neither and the host's band keeps something to wrap.
   *
   * This is the case whitlockk raised on #6914: with the gate's candidates taken
   * from the full five instead of the visible two, Cost's own computability
   * lets the gate hide both survivors and the strip renders nothing while the
   * host — which sees only the reader's set — still paints its padded band.
   */
  it("never takes the last visible card, whatever the reader already hid", () => {
    renderStrip({
      hidden: new Set([
        SessionsSummaryCardId.Sessions,
        SessionsSummaryCardId.Tokens,
        SessionsSummaryCardId.Cost,
      ]),
      hide: true,
      usage: usageFixture({ mergedLocPerDollar: null, mergedPrCount: null }),
    });

    expect(screen.getByText(PRS_SHIPPED_METRIC_CARD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
  });

  /**
   * The gate still thins a partial row: one absent delivery card goes while the
   * other survives, so the case above cannot pass merely because the gate stopped
   * hiding anything once the reader touched the menu.
   */
  it("still thins a partly-hidden row that keeps a survivor", () => {
    renderStrip({
      hidden: new Set([
        SessionsSummaryCardId.Sessions,
        SessionsSummaryCardId.Tokens,
      ]),
      hide: true,
      usage: usageFixture({ mergedPrCount: null }),
    });

    expect(
      screen.queryByText(PRS_SHIPPED_METRIC_CARD_LABEL)
    ).not.toBeInTheDocument();
    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
  });
});

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 12,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 42,
    mergedPrCount: 7,
    mergedLocPerDollar: 3.5,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
    ...overrides,
  };
}

function renderStrip({
  hidden,
  hide,
  usage,
}: {
  hidden?: ReadonlySet<string>;
  hide: boolean;
  usage: AgentSessionUsageSummary;
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: hide
          ? [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <SessionsSummaryCards
        githubConnected
        hiddenCardIds={hidden}
        isLoading={false}
        usage={usage}
      />
    </FeatureFlagAdapterProvider>
  );
}
