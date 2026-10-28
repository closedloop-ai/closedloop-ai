import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetSessionsPageTestState,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * ISS-9897 — the metric row behaves like the Sessions listing: a scope this
 * page load has not settled renders the skeleton, never the scope before it.
 *
 * The defect this closes could not be caught by a single-key test. The summary
 * read is mounted with `keepPreviousData`, so the moment ONE cache-key dimension
 * changes — the date window here — the observer is still holding the PREVIOUS
 * key's payload and reports it as `isPlaceholderData`. A page that renders
 * `data` without consulting that flag paints the old window's figures under the
 * new window's heading, and every single-scope test stays green because there
 * is no previous key for the observer to hold.
 *
 * `useAgentSessionUsage` is the mocked seam, so these cases state that observer
 * state directly. What the exact-key hit and the per-dimension key coverage are
 * pinned against is the real TanStack cache, in
 * `packages/app/agents/hooks/__tests__/use-agent-session-usage-cache-keys.test.tsx`.
 */

const PREVIOUS_SCOPE_SESSIONS = 565;
const SESSIONS_CARD_LABEL = "Sessions";
const LOADING_DETAIL = "Loading…";

function usageFixture(totalSessions: number): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

/** The settled read for the scope on screen. */
function settledRead() {
  return {
    data: usageFixture(PREVIOUS_SCOPE_SESSIONS),
    isError: false,
    isFetching: false,
    isLoading: false,
    isLoadingError: false,
    isPending: false,
    isPlaceholderData: false,
  };
}

/**
 * ONE cache-key dimension changed. `keepPreviousData` is serving the PREVIOUS
 * key's payload while the new key's read runs, which is exactly what
 * `isPlaceholderData` reports — `isPending` is false, because the observer has
 * a payload in hand; it simply is not this scope's.
 */
function previousScopeHeldRead() {
  return {
    ...settledRead(),
    isFetching: true,
    isPlaceholderData: true,
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

describe("sessions summary row across a cache-key change (ISS-9897)", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    localStorage.clear();
  });

  it("paints the figures the read settled for this scope", () => {
    useAgentSessionUsageMock.mockReturnValue(settledRead());

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    // The counterfactual half of the case below: this fixture DOES put the
    // figure on screen, so its absence there is the key change and not a
    // fixture that never rendered anything.
    expect(
      within(sessionsCard()).getByText(String(PREVIOUS_SCOPE_SESSIONS))
    ).toBeVisible();
    expect(screen.queryByText(LOADING_DETAIL)).toBeNull();
  });

  it("skeletons rather than paint the previous key's figures", () => {
    useAgentSessionUsageMock.mockReturnValue(previousScopeHeldRead());

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    // The whole deliverable: the payload in hand is the PREVIOUS window's, so
    // it must not paint under this one.
    expect(
      within(sessionsCard()).queryByText(String(PREVIOUS_SCOPE_SESSIONS))
    ).toBeNull();
    // …and a never-settled scope must not read as a settled zero either.
    expect(within(sessionsCard()).queryByText("0")).toBeNull();
    // The Sessions listing's own treatment: the shell, saying it is loading.
    expect(screen.getAllByText(LOADING_DETAIL).length).toBeGreaterThan(0);
  });
});
