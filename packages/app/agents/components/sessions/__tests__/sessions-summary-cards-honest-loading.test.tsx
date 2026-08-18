/**
 * ISS-5271 — the Sessions summary cards' honest never-loaded state, behind
 * `SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY` (default OFF).
 *
 * A sibling of `sessions-summary-cards.test.tsx` rather than more cases inside
 * it: that file is a whole-row suite already at the 1,000-line ceiling, and this
 * is a single, self-contained concern (which value a card reports when the usage
 * summary has never loaded).
 *
 * The defect these tests pin: when the usage query has not yet resolved
 * (`usage === undefined`) and there is no error, the Sessions and Total Tokens
 * cards fall back to `?? 0` and render a confident "0" beside a Cost card that
 * already honestly dashes — so the unflagged row reads `0 / 0 / —` and
 * contradicts itself. With the flag ON, those two cards skeleton their value
 * slot instead of fabricating a zero for a number that was never computed.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionsSummaryCards } from "../sessions-summary-cards";

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 12,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 42,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
    ...overrides,
  };
}

/**
 * Render the summary cards with only `sessions-summary-honest-loading` enabled,
 * through the real `FeatureFlagAdapterProvider` seam both shells use — not a
 * stubbed boolean. Mirrors the per-key mechanism from the cost-honesty sibling
 * (`sessions-summary-cards-cost-honesty.test.tsx`).
 */
function renderWithHonestLoading(
  usage: AgentSessionUsageSummary | undefined,
  isError = false
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY],
      })}
    >
      <SessionsSummaryCards isError={isError} isLoading={false} usage={usage} />
    </FeatureFlagAdapterProvider>
  );
}

// FEA-4128: the three always-available cards — Sessions, Total Tokens, Cost —
// that can skeleton their value slot while a source hydrates.
const ALWAYS_AVAILABLE_CARD_COUNT = 3;

describe("ISS-5271 honest never-loaded state", () => {
  it("skeletons the always-available value slots and suppresses the fabricated '0' while usage has never loaded (flag ON)", () => {
    const { container } = renderWithHonestLoading(undefined);

    // No fabricated zero in any form — the value slot is skeletoned instead.
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    // Card frames stay intact — labels are visible while the value hydrates.
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Total Tokens")).toBeInTheDocument();
    // One skeleton per always-available card (Sessions / Total Tokens / Cost).
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      ALWAYS_AVAILABLE_CARD_COUNT
    );
    // The row advertises its loading state to assistive technology.
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("clears skeletons and renders real values once usage settles (flag ON, last-good values unaffected)", () => {
    const { container } = renderWithHonestLoading(usageFixture());

    // The fixture has totalSessions: 12; a settled read shows the real value.
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("dashes all five cards on error without any skeleton — error outranks the never-loaded gate (flag ON)", () => {
    const { container } = renderWithHonestLoading(undefined, true);

    // A terminal error dashes rather than spins — the ISS-5271 arm checks
    // `!isError`, so cardsLoading stays false and the existing error contract
    // (five dashes, no skeleton) is unchanged.
    expect(screen.getAllByText("—")).toHaveLength(5);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("renders the pre-existing fabricated '0' while flag is OFF — closed-by-default ships no perceivable change", () => {
    // No FeatureFlagAdapterProvider: `useFeatureFlagEnabledOptional` resolves to
    // false (OFF), so the ISS-5271 skeleton arm is inactive and the old `?? 0`
    // path runs — Sessions and Total Tokens both render "0" for an unloaded summary.
    render(<SessionsSummaryCards isLoading={false} usage={undefined} />);

    // Both Sessions ("0") and Total Tokens ("0") render the fabricated zero;
    // queryAllByText returns an array and never throws on multiple matches.
    expect(screen.queryAllByText("0")).not.toHaveLength(0);
  });
});
