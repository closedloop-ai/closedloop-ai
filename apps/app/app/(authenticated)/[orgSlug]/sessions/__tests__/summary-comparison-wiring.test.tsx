import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SUMMARY_COMPARISON_PENDING_LABEL } from "@repo/app/agents/components/sessions/sessions-summary-delta-slots";
import { SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  resetSessionsPageTestState,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * ISS-7422 — the PAGE's own comparison wiring.
 *
 * The component-level suite in `@repo/app` proves the strip renders the right
 * affordance for a given delta object. It cannot prove this page builds that
 * object correctly, because it mirrors this file's wiring rather than importing
 * it — so deleting the gate argument here, or the `pending` fact beside it,
 * would restore the shipped defect with that suite still green.
 *
 * These two tests render the real `SessionsPage` against the two read states
 * that decide it, so the production call site is what fails.
 */

const SESSIONS_CARD_LABEL = "Sessions";
const NO_PRIOR_PERIOD = "No prior period";
const DELTA_CHIP = "metric-delta-chip";
/** Pinned from the ticket's own production screenshot. */
const SETTLED_CHIP_TEXT = "+63%";

function comparedUsage(): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 42,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    comparison: {
      priorStartDate: "2026-05-01T00:00:00.000Z",
      priorEndDate: "2026-07-30T00:00:00.000Z",
      deltas: { sessions: 63 },
    },
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    mergedLocPerDollar: 3.5,
    mergedPrCount: 7,
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalSessions: 12,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

/**
 * A revalidation of the scope already on screen: the figures are this scope's
 * own settled response, and a refetch is running behind them. `isPlaceholderData`
 * is false, so the page does NOT fall to its loading shell — the reader is
 * looking at settled cards.
 */
function revalidatingRead() {
  return {
    data: comparedUsage(),
    isLoading: false,
    isError: false,
    isLoadingError: false,
    isPlaceholderData: false,
    isFetching: true,
  };
}

function sessionsCard(): HTMLElement {
  const card = screen
    .getAllByText(SESSIONS_CARD_LABEL)[0]
    ?.closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error("No Sessions metric card found");
  }
  return card;
}

describe("sessions page comparison wiring (ISS-7422)", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
  });

  it("keeps the settled comparison through a revalidation, gate on", () => {
    enableSessionsPageFeatureFlag(
      SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
    );
    useAgentSessionUsageMock.mockReturnValue(revalidatingRead());

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    const card = sessionsCard();
    // The comparison rode the same response as the figure beside it, so it is
    // still true while the refetch runs.
    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent(
      SETTLED_CHIP_TEXT
    );
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).toBeNull();
    expect(
      within(card).queryByText(SUMMARY_COMPARISON_PENDING_LABEL)
    ).toBeNull();
  });

  // The gate's closed path, at the same read state. Without this, a page that
  // dropped the flag argument entirely would still pass the test above.
  it("still shows the pre-gate claim at that same read state, gate off", () => {
    useAgentSessionUsageMock.mockReturnValue(revalidatingRead());

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    const card = sessionsCard();
    expect(within(card).getByText(NO_PRIOR_PERIOD)).toBeInTheDocument();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();
  });
});
