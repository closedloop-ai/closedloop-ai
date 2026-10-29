import { InsightsScope } from "@repo/api/src/types/insights";
import { WebInsightsDataSourceProvider } from "@repo/app/insights/components/insights-data-source-provider";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DASHBOARD_DEFERRED_FIRST_PAINT_READS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "../../../../onboarding/lib/desktop-download-copy";
import {
  DEFERRED_SESSIONS_RELEASE_DEADLINE_MS,
  InsightsOverviewDashboard,
} from "../insights-overview-dashboard";

/**
 * ISS-7514 — which reads the org dashboard issues, and when.
 *
 * Everything the dashboard reads goes through ONE `apiClient.get`, so this
 * counts real requests by path against the real hooks, real data sources and
 * real React Query client rather than asserting on a mocked hook's arguments.
 * The insights sections are held in flight deliberately: the whole question is
 * what else is competing with them while they are.
 */

const { useApiClientMock } = vi.hoisted(() => ({
  useApiClientMock: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: useApiClientMock,
}));

const INSIGHTS_PATH_PREFIX = "/insights/";
const SESSIONS_PATH_PREFIX = "/agent-sessions";
const TEAMS_PATH = "/teams";
const GITHUB_STATUS_PATH = "/integrations/github";
const EMPTY_SERIES = { points: [], series: [] };
const LOADING_SESSIONS_LABEL = "Loading recent sessions";
const NO_RECENT_SESSIONS_TEXT = "No recent sessions";
const NO_SESSIONS_AT_ALL_TEXT = "No agent sessions yet";
const SESSIONS_ERROR_TEXT = "Recent sessions are temporarily unavailable.";

type PendingRequest = {
  path: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

let requestedPaths: string[] = [];
let pendingRequests: PendingRequest[] = [];

beforeEach(() => {
  requestedPaths = [];
  pendingRequests = [];
  localStorage.clear();
  useApiClientMock.mockReturnValue({
    get: (path: string) => {
      requestedPaths.push(path);
      return new Promise((resolve, reject) => {
        pendingRequests.push({ path, resolve, reject });
      });
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("org dashboard first-paint reads", () => {
  // The measurement this ticket is judged on, pinned so it cannot regress by
  // someone adding a fourth eager read. Written as literals rather than derived
  // from the component, and stated for BOTH gate positions so the difference
  // between them is the shipped claim.
  it.each([
    {
      deferred: false,
      expected: [
        "/agent-sessions",
        "/insights/agents",
        "/insights/delivery",
        "/insights/utilization",
        "/integrations/github",
      ],
      label: "closed",
    },
    {
      deferred: true,
      expected: [
        "/insights/agents",
        "/insights/delivery",
        "/insights/utilization",
        "/integrations/github",
      ],
      label: "open",
    },
  ])(
    "issues exactly these reads while the insights sections are in flight, gate $label",
    async ({ deferred, expected }) => {
      renderDashboard({ deferred });

      await waitFor(() => {
        expect(pathsMatching(INSIGHTS_PATH_PREFIX)).toHaveLength(3);
      });

      expect(firstPaintRoutes()).toEqual(expected);
    }
  );

  it("issues the Recent Sessions read on mount when the deferral gate is closed", async () => {
    renderDashboard({ deferred: false });

    await waitFor(() => {
      expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(1);
    });
  });

  it("holds the Recent Sessions read until the insights sections resolve, then issues it", async () => {
    renderDashboard({ deferred: true });

    // The three section reads are in flight — the slowest moment this ticket is
    // about — and the sessions scan is NOT competing with them.
    await waitFor(() => {
      expect(pathsMatching(INSIGHTS_PATH_PREFIX)).toHaveLength(3);
    });
    expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(0);

    await resolveInsights();

    // The other half of the pair: deferred is later, never never.
    await waitFor(() => {
      expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(1);
    });
  });

  it("keeps the sessions card loading — never a zero — while the deferred read has not run", async () => {
    renderDashboard({ deferred: true });

    await waitFor(() => {
      expect(
        screen.getByRole("status", { name: LOADING_SESSIONS_LABEL })
      ).toBeInTheDocument();
    });
    // The lie this ticket could have shipped: a card that has asked for nothing
    // rendering the same "no sessions" a reader gets for a genuine zero.
    expect(screen.queryByText(NO_RECENT_SESSIONS_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_SESSIONS_AT_ALL_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_ERROR_TEXT)).not.toBeInTheDocument();
    expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(0);
  });

  it("shows the true-zero state only once the deferred read resolves with no sessions", async () => {
    renderDashboard({ deferred: true });

    await resolveInsights();
    await waitFor(() => {
      expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(1);
    });
    expect(screen.queryByText(NO_SESSIONS_AT_ALL_TEXT)).not.toBeInTheDocument();

    await resolveSessions({ items: [], total: 0 });

    await waitFor(() => {
      expect(screen.getByText(NO_SESSIONS_AT_ALL_TEXT)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("status", { name: LOADING_SESSIONS_LABEL })
    ).not.toBeInTheDocument();
  });

  it("distinguishes a failed deferred read from both the loading and the empty state", async () => {
    renderDashboard({ deferred: true });

    await resolveInsights();
    await waitFor(() => {
      expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(1);
    });
    await failSessions();

    await waitFor(() => {
      expect(screen.getByText(SESSIONS_ERROR_TEXT)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("status", { name: LOADING_SESSIONS_LABEL })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(NO_RECENT_SESSIONS_TEXT)).not.toBeInTheDocument();
  });

  // The gate has to hold while the flag is UNRESOLVED, not merely while it reads
  // false. PostHog reports an unresolved flag as `false`, so a gate keyed on the
  // bare boolean issues the read on mount and the later flip only disables a
  // request already in flight — the deferral would measure as delivered here and
  // do nothing in a browser. `createStaticFeatureFlagAdapter` cannot express
  // that window, which is why this case brings its own resolving adapter.
  it("holds the read while the flag is still resolving, and still holds once it resolves ON", async () => {
    const flag = createResolvingFlagAdapter(
      DASHBOARD_DEFERRED_FIRST_PAINT_READS_FEATURE_FLAG_KEY
    );
    renderProvider(
      <InsightsOverviewDashboard
        emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
        getSessionHref={(session) => `/acme/sessions/${session.id}`}
        scope={InsightsScope.Org}
      />,
      { adapter: flag.adapter }
    );

    await waitFor(() => {
      expect(pathsMatching(INSIGHTS_PATH_PREFIX)).toHaveLength(3);
    });
    expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(0);

    act(() => flag.resolveEnabled());
    expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(0);

    // Released by the FIRST section landing, not all three — the trigger that
    // keeps the whole-page empty state a race rather than a post-paint swap.
    await resolveOneInsightsSection();

    await waitFor(() => {
      expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(1);
    });
  });

  /**
   * ISS-10486. The gate asked for a section SUCCESS, on the reasoning that an
   * errored section blanked the whole page anyway, so a read released by it
   * landed on a card nobody would see. That reasoning is gone: one failed
   * section now degrades its own rows and the page draws. A gate still waiting
   * for a success it will never get parks Recent Sessions behind the 8s deadline
   * on a dashboard that has already painted — the exact "permanent skeleton over
   * a healthy read" the deadline exists as a last resort against.
   *
   * No clock is moved here, so a release can only have come from the failure.
   */
  it("releases the deferred read on a section that FAILED, not only one that succeeded", async () => {
    renderDashboard({ deferred: true });

    await waitFor(() => {
      expect(pathsMatching(INSIGHTS_PATH_PREFIX)).toHaveLength(3);
    });
    // The precondition: nothing has settled, so the gate is genuinely closed.
    expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(0);

    await rejectOneInsightsSection();

    await waitFor(() => {
      expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(1);
    });
  });

  // whitlockk/#5819 review: the deferral must not become a new way for the card to
  // never load. A hung `/insights/*` never resolves AND never errors, so it
  // neither releases the gate nor trips the `DegradedState` short-circuit — an
  // unbounded wait strands a healthy `/agent-sessions` behind a permanent
  // skeleton, which is the "widgets load independently" line in
  // `packages/app/AGENTS.md`. Nothing is resolved anywhere in this case; only
  // the clock moves.
  it("issues the deferred read anyway once the release deadline passes with no section settled", async () => {
    vi.useFakeTimers();
    try {
      renderDashboard({ deferred: true });

      await vi.waitFor(() => {
        expect(pathsMatching(INSIGHTS_PATH_PREFIX)).toHaveLength(3);
      });
      // The precondition, so the assertion below is about the DEADLINE and not
      // about a gate that was open the whole time.
      expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          DEFERRED_SESSIONS_RELEASE_DEADLINE_MS
        );
      });

      await vi.waitFor(() => {
        expect(pathsMatching(SESSIONS_PATH_PREFIX)).toHaveLength(1);
      });
      // Still hung: the release came from the clock, not from a section that
      // quietly landed and would have opened the gate on its own.
      expect(pathsMatching(INSIGHTS_PATH_PREFIX)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reads the org's Teams, which no dashboard control can reach", async () => {
    renderDashboard({ deferred: true });

    await waitFor(() => {
      expect(requestedPaths).toContain(GITHUB_STATUS_PATH);
    });
    expect(requestedPaths).not.toContain(TEAMS_PATH);
  });

  it("reads the org's Teams for the surface that does render the scope selector", async () => {
    renderProvider(<div>scope selector surface</div>, { teamScopes: true });

    await waitFor(() => {
      expect(requestedPaths).toContain(TEAMS_PATH);
    });
  });
});

function pathsMatching(prefix: string): string[] {
  return requestedPaths.filter((path) => path.startsWith(prefix));
}

/** Requested routes without their query strings, order-independent. */
function firstPaintRoutes(): string[] {
  return [...new Set(requestedPaths.map((path) => path.split("?")[0]))].sort();
}

/**
 * Settle requests inside one `act`. The awaited microtask is load-bearing: it
 * lets the settled `queryFn` promises run their React Query continuations before
 * `act` exits, so the re-render they cause is covered.
 */
async function settleInsideAct(apply: () => void): Promise<void> {
  await act(async () => {
    apply();
    await Promise.resolve();
  });
}

async function resolveInsights(): Promise<void> {
  await settleInsideAct(() => {
    for (const request of takePending(INSIGHTS_PATH_PREFIX)) {
      request.resolve(insightsPayloadFor(request.path));
    }
  });
}

/** One insights section reaching a terminal ERROR, leaving the others in flight. */
async function rejectOneInsightsSection(): Promise<void> {
  await settleFirstInsightsSection((first) =>
    first.reject(new Error("section unavailable"))
  );
}

/** Land exactly one section read, leaving the other two in flight. */
async function resolveOneInsightsSection(): Promise<void> {
  await settleFirstInsightsSection((first) =>
    first.resolve(insightsPayloadFor(first.path))
  );
}

/**
 * Take the first in-flight insights request off the pending list and settle it
 * the way the caller says. The two helpers above differed by exactly that one
 * terminal action, so the filter-and-throw lives here once rather than twice.
 */
async function settleFirstInsightsSection(
  settle: (request: PendingRequest) => void
): Promise<void> {
  const [first] = pendingRequests.filter((request) =>
    request.path.startsWith(INSIGHTS_PATH_PREFIX)
  );
  if (!first) {
    throw new Error("no insights request in flight");
  }
  pendingRequests = pendingRequests.filter((request) => request !== first);
  await settleInsideAct(() => settle(first));
}

/**
 * A flag port that reports the key UNRESOLVED-and-false first, then resolved-and
 * -true — the PostHog shape the static test adapter cannot express. Every other
 * key stays resolved-and-false so the row gates behave as they do elsewhere.
 */
function createResolvingFlagAdapter(key: string): {
  adapter: FeatureFlagAdapter;
  resolveEnabled: () => void;
} {
  let settled = false;
  const listeners = new Set<() => void>();
  const subscribe = (onChange: () => void) => {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  };
  return {
    adapter: {
      useFeatureFlagEnabled: (candidate: string) =>
        useSyncExternalStore(subscribe, () => candidate === key && settled),
      useFeatureFlagResolved: (candidate: string) =>
        useSyncExternalStore(subscribe, () => candidate !== key || settled),
    },
    resolveEnabled: () => {
      settled = true;
      for (const onChange of listeners) {
        onChange();
      }
    },
  };
}

async function resolveSessions(payload: {
  items: unknown[];
  total: number;
}): Promise<void> {
  await settleInsideAct(() => {
    for (const request of takePending(SESSIONS_PATH_PREFIX)) {
      request.resolve(payload);
    }
  });
}

async function failSessions(): Promise<void> {
  await settleInsideAct(() => {
    for (const request of takePending(SESSIONS_PATH_PREFIX)) {
      request.reject(new Error("sessions unavailable"));
    }
  });
}

function takePending(prefix: string): PendingRequest[] {
  const matched = pendingRequests.filter((request) =>
    request.path.startsWith(prefix)
  );
  pendingRequests = pendingRequests.filter(
    (request) => !request.path.startsWith(prefix)
  );
  return matched;
}

function insightsPayloadFor(path: string): unknown {
  if (path.startsWith(`${INSIGHTS_PATH_PREFIX}delivery`)) {
    return {
      kpis: [],
      charts: { klocTrend: EMPTY_SERIES, prTrend: EMPTY_SERIES },
    };
  }
  if (path.startsWith(`${INSIGHTS_PATH_PREFIX}utilization`)) {
    return { kpis: [], charts: { eventActivity: EMPTY_SERIES } };
  }
  return {
    kpis: [],
    charts: { modelBreakdown: [], modelUsageOverTime: EMPTY_SERIES },
  };
}

function renderDashboard({ deferred }: { deferred: boolean }) {
  return renderProvider(
    <InsightsOverviewDashboard
      emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
      getSessionHref={(session) => `/acme/sessions/${session.id}`}
      scope={InsightsScope.Org}
    />,
    { deferred }
  );
}

function renderProvider(
  children: ReactNode,
  {
    deferred = false,
    teamScopes = false,
    adapter,
  }: {
    deferred?: boolean;
    teamScopes?: boolean;
    adapter?: FeatureFlagAdapter;
  } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FeatureFlagAdapterProvider
        adapter={
          adapter ??
          createStaticFeatureFlagAdapter({
            enabledFlags: deferred
              ? [DASHBOARD_DEFERRED_FIRST_PAINT_READS_FEATURE_FLAG_KEY]
              : [],
          })
        }
      >
        <NavigationProvider
          adapter={
            createMemoryNavigation({ initialPath: "/dashboard" }).adapter
          }
        >
          <WebInsightsDataSourceProvider teamScopes={teamScopes}>
            {children}
          </WebInsightsDataSourceProvider>
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    </QueryClientProvider>
  );
}
