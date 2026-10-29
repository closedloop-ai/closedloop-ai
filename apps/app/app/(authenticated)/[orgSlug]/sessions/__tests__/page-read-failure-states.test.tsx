import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { createAgentSessionUsageSummaryFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { agentSessionKeys } from "@repo/app/agents/hooks/agent-session-keys";
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionsPage from "../page";

/**
 * ISS-7519: the two read-failure states of the Sessions list, driven through the
 * REAL TanStack observer rather than a hand-set `isError` boolean.
 *
 * `isError` cannot tell the two apart: query-core's `error` reducer never clears
 * `data`, so a background refetch failure over a read that already SUCCEEDED
 * reports `isError === true` while `data` is still on screen. A fixture that
 * sets `isError: true` therefore proves nothing about which of the two the page
 * renders — only a real success-then-failure sequence through `useQuery` does.
 * These tests own that sequence; the page must render the two as DISTINCT
 * states.
 *
 * Providers are wired by hand rather than through `AppCoreStoryProviders`: that
 * harness builds its own `QueryClient` internally with no way to inject one, and
 * these tests need the client handle itself to drive the refetch and to read the
 * settled query state. It also pins `staleTime: Infinity`, which would suppress
 * the refetch under test. `sessions-page-test-helpers` is unusable here for a
 * different reason — it `vi.mock`s `use-agent-sessions` at module scope, which
 * would replace the very observer these tests exist to exercise.
 */

// Copy pinned as hand-written literals, deliberately not imported from the
// component that emits it: importing would let a copy change silently rewrite
// this test's expectation about which state rendered.
const OUTAGE_TITLE = "Couldn't load sessions";
const ONBOARDING_TITLE = "No sessions synced yet";
const ONBOARDING_ACTION_NAME = "Connect a compute target";
// The genuinely-empty state shown when the connected-agent signal is UNKNOWN.
const NEUTRAL_EMPTY_TITLE = "No sessions yet";

const { hasConnectedAgentMock } = vi.hoisted(() => ({
  hasConnectedAgentMock: { value: false as boolean | undefined },
}));

// The onboarding-vs-neutral split reads a SEPARATE org-wide query. It is not the
// query under test, so it is pinned to "never connected" — that is the reported
// harm's precondition (the org that should be seeing the connect CTA).
vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: hasConnectedAgentMock.value }),
}));

// `useAgentSessionsDataSource` constructs the fallback HTTP client
// unconditionally (Rules of Hooks), so an api-client stub is required even
// though every read here is served by the injected source.
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port. Closed and ready, matching this suite's other gates.
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
  // FEA-4201: the readiness-carrying read. Ready and OFF, which is this suite's
  // existing posture for every flag — the read-failure states under test are the
  // flag-off ones, and an unresolved gate would hold the read they assert on.
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/sessions",
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: ReactNode }) => (
    <div data-testid="header">{children}</div>
  ),
}));

// The toolbar is not under test and pulls its own facet/popover stack.

const EMPTY_USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  { totalSessions: 0 }
);

const EMPTY_LIST: AgentSessionListResponse = {
  items: [],
  total: 0,
  viewerScope: AgentSessionViewerScope.Organization,
};

type ListBehavior = "succeed" | "fail";

let listBehavior: ListBehavior;
let listCallCount: number;
let queryClient: QueryClient;

function createControllableDataSource(): AgentSessionsDataSource {
  return {
    scope: "iss-7519-test",
    list: () => {
      listCallCount += 1;
      if (listBehavior === "fail") {
        return Promise.reject(new Error("sessions list read failed"));
      }
      return Promise.resolve(EMPTY_LIST);
    },
    usage: () => Promise.resolve(EMPTY_USAGE),
    // This page reads the list and the summary as two independent queries
    // (FEA-4177); the remaining ports belong to other surfaces.
    detail: () => Promise.reject(new Error("detail is not read by this page")),
    analytics: () =>
      Promise.reject(new Error("analytics is not read by this page")),
    pageData: () =>
      Promise.reject(new Error("pageData is not read by this page")),
  };
}

function renderSessionsPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSessionsDataSourceProvider
        dataSource={createControllableDataSource()}
      >
        <SessionsPage />
      </AgentSessionsDataSourceProvider>
    </QueryClientProvider>
  );
}

describe("sessions list read-failure states (ISS-7519)", () => {
  beforeEach(() => {
    listBehavior = "succeed";
    listCallCount = 0;
    hasConnectedAgentMock.value = false;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // query-core schedules observer notifications onto a `setTimeout(…, 0)`
    // macrotask, which an `act` microtask drain does NOT reach — the DOM would
    // still hold the pre-error frame and every assertion below would read a
    // stale render. Notify synchronously instead, so `act` sees the error the
    // moment the query settles. No timers, no waiting.
    notifyManager.setScheduler((callback) => callback());
  });

  afterEach(() => {
    notifyManager.setScheduler(defaultScheduler);
    queryClient.clear();
  });

  it("keeps the onboarding state when a refetch fails over a read that already succeeded", async () => {
    renderSessionsPage();

    // The genuinely-empty org, hydrated from a SUCCEEDED read.
    expect(await screen.findByText(ONBOARDING_TITLE)).toBeInTheDocument();

    // Now the API blip: a real refetch through the real observer, which fails.
    // Wrapped in `act` so the observer's error notification is flushed into the
    // tree before we assert — asserting on the un-flushed DOM would pass on the
    // stale frame no matter what the page does with the error.
    listBehavior = "fail";
    const callsBeforeRefetch = listCallCount;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: agentSessionKeys.lists() });
    });

    // Positive proof the failure actually landed on the observer: the list was
    // re-read, and query-core settled it to `error` while retaining the data it
    // already held (which is precisely why `isError` cannot classify it).
    expect(listCallCount).toBeGreaterThan(callsBeforeRefetch);
    const settled = queryClient
      .getQueryCache()
      .findAll({ queryKey: agentSessionKeys.lists() })
      .find((query) => query.state.status === "error");
    expect(settled).toBeDefined();
    expect(settled?.state.data).toBeDefined();

    // The org is fine and the data is fine, so the page must not claim an outage.
    expect(screen.getByText(ONBOARDING_TITLE)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: ONBOARDING_ACTION_NAME })
    ).toBeInTheDocument();
    expect(screen.queryByText(OUTAGE_TITLE)).not.toBeInTheDocument();
  });

  it("claims the outage when the very first read fails and no data was ever held", async () => {
    listBehavior = "fail";

    renderSessionsPage();

    // The distinct sibling state: nothing was ever loaded, so the failed read is
    // the only thing we know — and the page must say so rather than render a
    // false onboarding all-clear.
    expect(await screen.findByText(OUTAGE_TITLE)).toBeInTheDocument();
    const erroredQuery = queryClient
      .getQueryCache()
      .findAll({ queryKey: agentSessionKeys.lists() })
      .find((query) => query.state.status === "error");
    // Guard before the optional chain: without it a MISSING query would satisfy
    // `?.state.data` being undefined and the assertion would pass vacuously.
    expect(erroredQuery).toBeDefined();
    expect(erroredQuery?.state.data).toBeUndefined();
    expect(screen.queryByText(ONBOARDING_TITLE)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: ONBOARDING_ACTION_NAME })
    ).not.toBeInTheDocument();
  });

  // The refetch failure disables `useHasConnectedAgent` (its `enabled` reads
  // `sessionsQuery.isSuccess`), so the connected-agent signal can still be
  // unknown on this frame. `SessionsEmptyState` deliberately treats unknown as
  // "not never-connected" and shows the neutral copy rather than flashing the
  // onboarding CTA at an org that may already be onboarded. Pinned here because
  // the fix newly makes this frame reachable: whichever empty renders, it must
  // not be the outage claim.
  it("renders the neutral empty, not an outage, when a refetch fails and the connected-agent signal is unknown", async () => {
    hasConnectedAgentMock.value = undefined;
    renderSessionsPage();

    expect(await screen.findByText(NEUTRAL_EMPTY_TITLE)).toBeInTheDocument();

    listBehavior = "fail";
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: agentSessionKeys.lists() });
    });

    const settled = queryClient
      .getQueryCache()
      .findAll({ queryKey: agentSessionKeys.lists() })
      .find((query) => query.state.status === "error");
    expect(settled).toBeDefined();
    expect(settled?.state.data).toBeDefined();

    expect(screen.getByText(NEUTRAL_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(OUTAGE_TITLE)).not.toBeInTheDocument();
  });
});
