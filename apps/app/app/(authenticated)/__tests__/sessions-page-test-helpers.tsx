import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { Children, isValidElement, type ReactNode } from "react";
import { type Mock, vi } from "vitest";

const {
  enabledFeatureFlagsMock,
  unresolvedFeatureFlagsMock,
  navigationReplaceMock,
  pathnameMock,
  searchParamsMock,
  sessionsTotalMock,
  useAgentSessionsMock,
  useAgentSessionsPageDataMock,
  useAgentSessionUsageMock,
  viewReadyOverrideMock,
} = vi.hoisted<{
  enabledFeatureFlagsMock: Set<string>;
  unresolvedFeatureFlagsMock: Set<string>;
  navigationReplaceMock: Mock;
  pathnameMock: { value: string };
  searchParamsMock: URLSearchParams;
  sessionsTotalMock: { value: number };
  useAgentSessionsMock: Mock;
  useAgentSessionsPageDataMock: Mock;
  useAgentSessionUsageMock: Mock;
  viewReadyOverrideMock: { value: boolean | null };
}>(() => ({
  enabledFeatureFlagsMock: new Set<string>(),
  unresolvedFeatureFlagsMock: new Set<string>(),
  navigationReplaceMock: vi.fn(),
  pathnameMock: { value: "/sessions" },
  searchParamsMock: new URLSearchParams(),
  sessionsTotalMock: { value: 1 },
  useAgentSessionsMock: vi.fn(),
  useAgentSessionsPageDataMock: vi.fn(),
  useAgentSessionUsageMock: vi.fn(),
  viewReadyOverrideMock: { value: null },
}));

// FEA-4177: the org Sessions page reads the list (`useAgentSessions`) and the
// summary usage (`useAgentSessionUsage`) as INDEPENDENT queries; the self-scoped
// page + active-runs panel also use the list-only `useAgentSessions`. The
// combined `useAgentSessionsPageData` mock is retained (the desktop view still
// uses it) so the mocked module keeps every named export.
vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: useAgentSessionsMock,
  useAgentSessionsPageData: useAgentSessionsPageDataMock,
  useAgentSessionUsage: useAgentSessionUsageMock,
}));

// PRD-536 §5: the Sessions page now probes the org-scoped connected-agent
// signal. Default it to "unknown" (undefined) so these layout/pagination tests
// keep the neutral filters empty-state message without an API-client provider.
vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

// The PRD-536 G1 per-row transcript-freshness badge reads its flag via
// `useFeatureFlagEnabledOptional`, and other flag reads resolve through a
// <FeatureFlagAdapterProvider>, which these page tests render without, so stub
// both flag hooks. The set is EMPTY by default, so every flag resolves to the
// dark-launch default (off) exactly as before; `enableSessionsPageFeatureFlag`
// opts one test into a flag-on branch (ISS-4901).
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFeatureFlagsMock.has(key),
  useFeatureFlagEnabledOptional: (key: string) =>
    enabledFeatureFlagsMock.has(key),
  // FEA-4201: the readiness-carrying read. Ready by DEFAULT, so every suite that
  // predates the gate keeps the synchronous behaviour it was written against;
  // `holdSessionsFeatureFlagResolution` opts one test into the unresolved window
  // an asynchronous provider really has.
  useFeatureFlagGate: (key: string) => ({
    enabled: enabledFeatureFlagsMock.has(key),
    isReady: !unresolvedFeatureFlagsMock.has(key),
  }),
  // ISS-9692: the same read through the provider-optional port, which is what
  // `useTablePageSizeOptions` uses (these page tests render no adapter). Shares
  // both mock sets, so `holdSessionsFeatureFlagResolution` can hold the
  // page-size ladder unresolved exactly as it holds the window.
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: enabledFeatureFlagsMock.has(key),
    isReady: !unresolvedFeatureFlagsMock.has(key),
  }),
}));

// ISS-6382: the REAL `useSessionsViewState` still runs — this only lets a test
// pin `isViewReady`, the one output whose true value is a post-mount race no
// jsdom assertion can land on. `null` (the default, restored by
// `resetSessionsPageTestState`) is a straight passthrough, so every other suite
// in this module keeps the unmocked hook.
vi.mock("@repo/app/agents/hooks/use-sessions-view-state", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/agents/hooks/use-sessions-view-state")
    >();
  return {
    ...actual,
    useSessionsViewState: (persistKey?: string) => {
      const state = actual.useSessionsViewState(persistKey);
      if (viewReadyOverrideMock.value === null) {
        return state;
      }
      return { ...state, isViewReady: viewReadyOverrideMock.value };
    },
  };
});

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => searchParamsMock,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: navigationReplaceMock,
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => pathnameMock.value,
}));

vi.mock("@repo/design-system/components/ui/select", () => {
  /**
   * The real control names itself on its TRIGGER (`SelectTrigger aria-label`), so
   * a stub that renders no trigger renders a `<select>` with no accessible name —
   * an axe `select-name` violation this harness invented (ISS-10301). The v1
   * toolbar stand-in rendered no Selects at all, so the page's a11y sweeps never
   * reached one until the real v2 footer arrived.
   *
   * Lifting the trigger's label onto the `<select>` is what makes the stub report
   * the production accessible name, so a shipped control that LOSES its label
   * still reddens these sweeps.
   */
  function SelectTrigger(_props: {
    "aria-label"?: string;
    children?: ReactNode;
  }) {
    return null;
  }
  function triggerLabel(children: ReactNode): string | undefined {
    for (const child of Children.toArray(children)) {
      if (isValidElement(child) && child.type === SelectTrigger) {
        return (child.props as { "aria-label"?: string })["aria-label"];
      }
    }
    return;
  }
  return {
    // `disabled` is forwarded (ISS-9216): the stub is how these suites reach every
    // Select on the page, so a stub that drops it reports an operable control for
    // one the user cannot touch.
    Select: ({
      children,
      disabled,
      onValueChange,
      value,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onValueChange: (value: string) => void;
      value: string;
    }) => (
      <select
        aria-label={triggerLabel(children)}
        disabled={disabled}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        value={value}
      >
        {children}
      </select>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({
      children,
      value,
    }: {
      children: ReactNode;
      value: string;
    }) => <option value={value}>{children}</option>,
    SelectTrigger,
    SelectValue: () => null,
  };
});

// ISS-5478: this stand-in RENDERS ITS CHILDREN. The page's header actions are a
// real page-level contract now (Refresh lives in the header's right slot), and a
// mock that dropped children would keep every assertion about them green no
// matter where the page actually mounted them.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: ReactNode }) => (
    <div data-testid="header">{children}</div>
  ),
}));

// ISS-7052 Part A: with `grid-table-v2` ON the page renders `SessionsListV2Host`,
// which runs the REAL `useSessionOwnerNameResolver`. Its roster read owns a
// `useApiClient()` call that THROWS without an <AuthAdapterProvider> — the same
// reason the toolbar below and the CSV export row are stubbed. Mocking the
// ROSTER rather than the resolver keeps the resolver's own gating under test:
// it still decides whether a name is needed, and simply resolves none, which is
// its documented fallback.
// ISS-8718: the v2 lead cell also runs the REAL rename gate, whose ownership
// read is `useCurrentUser` — another `useApiClient()` that throws here. A
// factory missing the export fails the whole file before any assertion runs,
// which is what it did. `data: undefined` is the gate's documented "viewer not
// yet known" answer, so no rename control is offered and these suites keep
// asserting exactly the page they asserted before.
// ISS-12975: #9107's registered bulk actions read the real `userKeys` factory
// to invalidate the organization-users list, so the mock carries the original.
vi.mock("@repo/app/users/hooks/use-users", async (importOriginal) => ({
  userKeys: (
    await importOriginal<typeof import("@repo/app/users/hooks/use-users")>()
  ).userKeys,
  useCurrentUser: () => ({ data: undefined }),
  useOrganizationUsers: () => ({ data: undefined }),
}));

// ISS-5355, and the same reasoning one comment up: the v2 host also runs the
// REAL `useSessionProjectNameResolver` so the Project facet has a name for a
// project the active window cannot label. Its org-project read owns the same
// throwing `useApiClient()`. Mocking the PROJECT LIST rather than the resolver
// keeps the resolver's own gating under test.
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({ data: undefined }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

type ViewerScope = "self" | "organization";

const DEFAULT_TOTAL = 1;

// The org `[orgSlug]/sessions` page sends multi-select facet arrays + a default
// date window instead of the legacy single-value harness/status filters.
export const orgDefaultSessionsPageHookArgs = {
  limit: 25,
  offset: 0,
  statuses: [],
  userIds: [],
  repositories: [],
  userId: undefined,
};

export const selectedUserSessionsPageHookArgs = {
  limit: 25,
  offset: 0,
  userId: "user-123",
};

/**
 * The Sessions history table always queries with a concrete numeric `offset`;
 * the live "Active runs" panel queries by status with no pagination offset.
 * These page-layout tests assert on the history table + pagination, so the
 * shared mock resolves the panel query to "no live runs" — keeping the shared
 * fixture rendered exactly once (in the table) and the table query the subject
 * of every offset assertion.
 */
function isSessionsTableQuery(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as { offset?: unknown }).offset === "number"
  );
}

/**
 * Args of the most recent Sessions history-table query (skips the panel).
 * FEA-4157: the org page routes the list through the combined
 * `useAgentSessionsPageData`, so the table args live on THAT mock; the self page
 * + active-runs panel still call `useAgentSessions`. Scan both call streams so a
 * single accessor serves every page test.
 */
/**
 * The OPTIONS argument of the most recent Sessions history-table read — the
 * `{ enabled, placeholderData }` object, not the filters.
 *
 * FEA-4201: a gate that holds a read is only observable here. The filters
 * accessor above cannot see it, because a held read is still CALLED with the
 * filters it would use; what changes is whether it is allowed to fetch.
 */
export function lastSessionsTableCallOptions():
  | Record<string, unknown>
  | undefined {
  const calls = [
    ...useAgentSessionsMock.mock.calls,
    ...useAgentSessionsPageDataMock.mock.calls,
  ];
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index];
    if (isSessionsTableQuery(call?.[0])) {
      return call?.[1] as Record<string, unknown> | undefined;
    }
  }
  return undefined;
}

export function lastSessionsTableCallArgs():
  | Record<string, unknown>
  | undefined {
  const calls = [
    ...useAgentSessionsMock.mock.calls,
    ...useAgentSessionsPageDataMock.mock.calls,
  ];
  for (let index = calls.length - 1; index >= 0; index--) {
    const first = calls[index]?.[0];
    if (isSessionsTableQuery(first)) {
      return first as Record<string, unknown>;
    }
  }
  return undefined;
}

export const sessionLinkName = "Shared sessions list extraction";
export const sessionHistoryHeading = "Session History";
export const sessionsPageCount = "Page 1 of 1";
// FEA-4181: both web Sessions surfaces now render the shared honest
// `SessionsEmptyState`. A hydrated, unfiltered, zero-row org resolves to the
// genuine "No sessions yet" onboarding zero-state (not the old "No sessions
// found" that couldn't tell a filtered-away scope from a genuinely-empty one).
export const sessionsEmptyTitle = "No sessions yet";
export const sessionsEmptyDescription =
  "Sessions appear here once your connected compute targets sync their agent history.";

export {
  navigationReplaceMock,
  useAgentSessionsMock,
  useAgentSessionsPageDataMock,
  useAgentSessionUsageMock,
};

const DEFAULT_USAGE = { totalSessions: 1, totalEstimatedCost: 0 };

/** A populated list response for the given viewer scope + total. */
function populatedListResponse(viewerScope: ViewerScope | undefined) {
  return {
    items: [createAgentSessionListItemFixture()],
    total: sessionsTotalMock.value,
    ...(viewerScope ? { viewerScope } : {}),
  };
}

/** An empty list response for the given viewer scope. */
function emptyListResponse(viewerScope: ViewerScope | undefined) {
  return { items: [], total: 0, ...(viewerScope ? { viewerScope } : {}) };
}

/**
 * FEA-4157: point the combined `useAgentSessionsPageData` mock (org page) at the
 * same list fixture the list-only `useAgentSessions` mock (self page) serves,
 * paired with the shared usage fixture, so both surfaces read identical rows.
 * The org page only queries the table (a real `offset`), so the panel branch
 * never applies here — resolve every call to the populated page shape.
 */
function pageDataResult(list: ReturnType<typeof populatedListResponse>) {
  return {
    data: { list, usage: DEFAULT_USAGE },
    isLoading: false,
    isLoadingError: false,
  };
}

export function resetSessionsPageTestState(viewerScope: ViewerScope) {
  enabledFeatureFlagsMock.clear();
  unresolvedFeatureFlagsMock.clear();
  viewReadyOverrideMock.value = null;
  navigationReplaceMock.mockReset();
  pathnameMock.value =
    viewerScope === "organization" ? "/acme/sessions" : "/sessions";
  sessionsTotalMock.value = DEFAULT_TOTAL;
  // Clear every param (page/userId plus any FEA-3560 facet params a test set).
  for (const key of [...new Set(searchParamsMock.keys())]) {
    searchParamsMock.delete(key);
  }
  useAgentSessionsMock.mockReset();
  useAgentSessionsMock.mockImplementation((args: unknown) =>
    isSessionsTableQuery(args)
      ? {
          data: populatedListResponse(viewerScope),
          isLoading: false,
        }
      : { data: emptyListResponse(viewerScope), isLoading: false }
  );
  useAgentSessionsPageDataMock.mockReset();
  useAgentSessionsPageDataMock.mockImplementation((args: unknown) =>
    pageDataResult(
      isSessionsTableQuery(args)
        ? populatedListResponse(viewerScope)
        : emptyListResponse(viewerScope)
    )
  );
  useAgentSessionUsageMock.mockReset();
  useAgentSessionUsageMock.mockReturnValue({
    data: DEFAULT_USAGE,
    isLoading: false,
  });
}

export function setSelectedSessionUser(userId: string) {
  searchParamsMock.set("userId", userId);
}

export function setSessionsPageQuery(page: string) {
  searchParamsMock.set("page", page);
}

/**
 * Seeds a FEA-3560 facet param (repeated per value) on the mocked list URL, as
 * a detail→back / reload restore would present it to the page.
 */
export function setSessionsFacetQuery(name: string, values: string[]) {
  searchParamsMock.delete(name);
  for (const value of values) {
    searchParamsMock.append(name, value);
  }
}

export function clearSessionsPageQuery() {
  searchParamsMock.delete("page");
}

export function setSessionsTotal(total: number) {
  sessionsTotalMock.value = total;
  useAgentSessionsMock.mockImplementation((args: unknown) =>
    isSessionsTableQuery(args)
      ? {
          data: populatedListResponse(undefined),
          isLoading: false,
        }
      : { data: emptyListResponse(undefined), isLoading: false }
  );
  useAgentSessionsPageDataMock.mockImplementation((args: unknown) =>
    pageDataResult(
      isSessionsTableQuery(args)
        ? populatedListResponse(undefined)
        : emptyListResponse(undefined)
    )
  );
}

/**
 * A first fetch actually in flight. ISS-6382 moved the page's skeleton branch
 * from `isLoading` to `isPending` (which also covers a read the restore gate is
 * holding closed), so the fixture carries both flags exactly as TanStack Query
 * reports them for this state — not a weakened expectation, a corrected shape.
 */
export function mockSessionsPageLoadingState() {
  useAgentSessionsMock.mockReturnValue({
    data: undefined,
    isLoading: true,
    isPending: true,
  });
  useAgentSessionsPageDataMock.mockReturnValue({
    data: undefined,
    isLoading: true,
    isPending: true,
    isLoadingError: false,
  });
}

/**
 * ISS-6382: the shape TanStack Query reports for a read held CLOSED by the
 * restore gate — `isPending` true (there is nothing to show) while `isLoading`
 * is false, because no fetch is in flight. The distinction is the whole point:
 * the pre-gate page keyed its skeleton on `isLoading`, so this state fell
 * through to the zero-row branch and rendered the honest-empty surface.
 */
export function mockSessionsPageGatedRead() {
  useAgentSessionsMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isPending: true,
  });
  useAgentSessionUsageMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isPending: true,
  });
}

export function mockSessionsPageEmptyState(viewerScope: ViewerScope) {
  useAgentSessionsMock.mockReturnValue({
    data: emptyListResponse(viewerScope),
    isLoading: false,
  });
  useAgentSessionsPageDataMock.mockReturnValue({
    data: { list: emptyListResponse(viewerScope), usage: DEFAULT_USAGE },
    isLoading: false,
    isLoadingError: false,
  });
}

/**
 * FEA-4177 (whitlockk): the list query's error state on an INITIAL rejection — no
 * data, `isError` true. The org sessions page reads `useAgentSessions`; return a
 * `refetch` spy so the Retry affordance's wiring is assertable.
 *
 * ISS-7414 (whitlockk review): the SUMMARY read is errored here too, which is what a
 * general outage actually looks like — one failure erroring both halves. It now
 * carries its own `refetch` spy, returned rather than passed, because without one
 * the recovery control's effect on the cards and facet counts cannot be asserted
 * at all: the page would call `refetch()` on a mock that never had one. Resolves,
 * because the page attaches a self-catch to the returned promise.
 *
 * ISS-7519: an initial rejection sets BOTH flags on the real observer
 * (`isLoadingError = isError && !hasData`), so this fixture states both. They
 * diverge only on a refetch failure over held data — the case this hand-set
 * fixture cannot represent at all, and which
 * `sessions/__tests__/page-read-failure-states.test.tsx` drives through a real
 * query instead.
 */
export function mockSessionsPageListErrorState(refetch: () => void): {
  usageRefetch: Mock;
} {
  const usageRefetch = vi.fn().mockResolvedValue(undefined);
  useAgentSessionsMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    isLoadingError: true,
    refetch,
  });
  useAgentSessionUsageMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isLoadingError: true,
    refetch: usageRefetch,
  });
  return { usageRefetch };
}

/**
 * Turn one PostHog flag on for the current test (ISS-4901). Cleared by
 * `resetSessionsPageTestState`, so a test that does not call this keeps the
 * dark-launch default and the surface it asserts is the flag-off one.
 */
export function enableSessionsPageFeatureFlag(key: string) {
  enabledFeatureFlagsMock.add(key);
}

/**
 * FEA-4201: hold one flag in the UNRESOLVED window an asynchronous provider
 * (PostHog) really has, where the flag reads `false` because no answer has
 * arrived yet rather than because it is off. The state a synchronous mock cannot
 * otherwise reach, and the one a read keyed off the flag must not act on.
 */
export function holdSessionsFeatureFlagResolution(key: string) {
  unresolvedFeatureFlagsMock.add(key);
}

/**
 * ISS-5478: seeds `refetch` spies on the page's two reads (the list and the
 * summary aggregates), keeping the populated list the default state renders.
 * Without these the page calls `refetch()` on a mock that never had one, so a
 * re-read cannot be asserted at all.
 *
 * ISS-5975 (whitlockk review): the two reads also carry `isStale`/`isError`, because
 * the property under test moved from a click handler to the page's freshness
 * GROUP — and what decides whether that group re-reads is precisely the mix of
 * those flags across the two queries. `freshness` sets them per query; both
 * default to fresh and healthy, which is the shape every pre-existing caller
 * wants.
 */
export function mockSessionsPageRefetchSpies(
  viewerScope: ViewerScope,
  freshness: SessionsPageQueryFreshness = {}
): {
  listRefetch: Mock;
  usageRefetch: Mock;
} {
  const listRefetch = vi.fn();
  const usageRefetch = vi.fn();
  useAgentSessionsMock.mockImplementation((args: unknown) => ({
    data: isSessionsTableQuery(args)
      ? populatedListResponse(viewerScope)
      : emptyListResponse(viewerScope),
    isError: freshness.listIsError ?? false,
    isLoading: false,
    isStale: freshness.listIsStale ?? false,
    refetch: listRefetch,
  }));
  useAgentSessionUsageMock.mockReturnValue({
    data: DEFAULT_USAGE,
    isError: freshness.usageIsError ?? false,
    isLoading: false,
    isStale: freshness.usageIsStale ?? false,
    refetch: usageRefetch,
  });
  return { listRefetch, usageRefetch };
}

/** Per-query freshness/health overrides for {@link mockSessionsPageRefetchSpies}. */
export type SessionsPageQueryFreshness = {
  listIsError?: boolean;
  listIsStale?: boolean;
  usageIsError?: boolean;
  usageIsStale?: boolean;
};

/**
 * ISS-6382 (whitlockk review): pin `isViewReady` false for the whole test, so the
 * held-closed window is assertable at all. The restore commits in an effect, and
 * `render()` flushes effects, so a plain render never leaves that window
 * observable in the DOM — only in the first entry of a mock's call log.
 *
 * Everything else about the page stays real, including the mocked reads: leave
 * them on the default POPULATED fixture and you have the warm-cache shape, which
 * is what this exists for. `enabled: false` does not make a warm observer
 * pending, so a page inferring readiness from query state renders the
 * pre-restore rows, cards, and total here while the gate is shut.
 */
export function holdSessionsViewRestore() {
  viewReadyOverrideMock.value = false;
}
