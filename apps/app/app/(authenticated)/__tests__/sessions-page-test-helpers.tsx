import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import type { ReactNode } from "react";
import { type Mock, vi } from "vitest";

/**
 * The slice of `SessionFacetFilters` the toolbar stand-in reads. Deliberately
 * structural rather than the real type: this module is hoisted into `vi.mock`
 * factories, so it must not pull `@repo/app`'s facet adapter in at module-eval
 * time.
 */
type StubSessionFacetFilters = {
  statuses: string[];
  userIds: string[];
  repositories: string[];
};

const {
  enabledFeatureFlagsMock,
  navigationReplaceMock,
  pathnameMock,
  searchParamsMock,
  sessionsTotalMock,
  useAgentSessionsMock,
  useAgentSessionsPageDataMock,
  useAgentSessionUsageMock,
} = vi.hoisted<{
  enabledFeatureFlagsMock: Set<string>;
  navigationReplaceMock: Mock;
  pathnameMock: { value: string };
  searchParamsMock: URLSearchParams;
  sessionsTotalMock: { value: number };
  useAgentSessionsMock: Mock;
  useAgentSessionsPageDataMock: Mock;
  useAgentSessionUsageMock: Mock;
}>(() => ({
  enabledFeatureFlagsMock: new Set<string>(),
  navigationReplaceMock: vi.fn(),
  pathnameMock: { value: "/sessions" },
  searchParamsMock: new URLSearchParams(),
  sessionsTotalMock: { value: 1 },
  useAgentSessionsMock: vi.fn(),
  useAgentSessionsPageDataMock: vi.fn(),
  useAgentSessionUsageMock: vi.fn(),
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
}));

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

vi.mock("@repo/design-system/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <select
      onChange={(event) => onValueChange(event.currentTarget.value)}
      value={value}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

// ISS-5478: this stand-in RENDERS ITS CHILDREN. The page's header actions are a
// real page-level contract now (Refresh lives in the header's right slot), and a
// mock that dropped children would keep every assertion about them green no
// matter where the page actually mounted them.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: ReactNode }) => (
    <div data-testid="header">{children}</div>
  ),
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: ({
    filters,
    onFiltersChange,
    scopeUserId,
    onRemoveScopeUser,
    usage,
  }: {
    filters: StubSessionFacetFilters;
    onFiltersChange: (next: StubSessionFacetFilters) => void;
    scopeUserId?: string | null;
    onRemoveScopeUser?: (next: StubSessionFacetFilters) => void;
    usage?: { byHarness?: { harness: string }[] };
  }) => (
    <div>
      {/* ISS-5975: the `onRefresh` prop and its `toolbar-received-on-refresh`
          marker are gone with the control itself. The real `SessionsToolbar` no
          longer accepts the prop at all, so a page wiring one back would fail
          typecheck rather than needing a runtime marker here; the toolbar's own
          absence guard lives in
          `packages/app/agents/components/sessions/__tests__/sessions-prototype-alignment.test.tsx`. */}
      {/* ISS-5283: the facet OPTION lists are built from this `usage`, so the
          page contract under test is WHICH usage response reaches the toolbar.
          Rendering the harness keys is the smallest observable proxy for that —
          the real option builder is covered in the toolbar's own tests. */}
      <span data-testid="toolbar-usage-harnesses">
        {(usage?.byHarness ?? []).map((entry) => entry.harness).join(",")}
      </span>
      {/* ISS-4728: the real chip row is exercised in
          `sessions-active-filters-bar.test.tsx`. This stand-in only proves the
          page hands the toolbar the selected-user scope AND a way to clear it —
          a scope forwarded without its remover would render a chip that names a
          filter it cannot remove. */}
      {scopeUserId ? (
        <span data-testid="toolbar-scope-user-id">{scopeUserId}</span>
      ) : null}
      {onRemoveScopeUser ? (
        <button onClick={() => onRemoveScopeUser(filters)} type="button">
          Remove selected user scope
        </button>
      ) : null}
      {/* ISS-4866 (review cid 3701353686): the MERGED removal — the real chip
          row hands back the facets with the scoped user already dropped from
          the Owner facet, so the page performs ONE URL write for both
          narrowers. Modelled here as a distinct button because the page-level
          contract under test is the resulting URL, and the old two-write
          version passed every "both callbacks fired" assertion while leaving
          `?userId` in place. */}
      {onRemoveScopeUser && scopeUserId ? (
        <button
          onClick={() =>
            onRemoveScopeUser({
              ...filters,
              userIds: filters.userIds.filter((id) => id !== scopeUserId),
            })
          }
          type="button"
        >
          Remove merged owner scope
        </button>
      ) : null}
      <button
        onClick={() =>
          onFiltersChange({
            statuses: [],
            userIds: ["user-e2e"],
            repositories: [],
          })
        }
        type="button"
      >
        Filter owner Ada
      </button>
      <button
        onClick={() =>
          onFiltersChange({
            // ISS-4696: facet-VALID values only. This stand-in stands in for
            // the real Filter popover, which can only ever emit what
            // `SESSION_STATUS_FILTER_OPTIONS` offers — so seeding it with the
            // retired `completed`/`abandoned` made the page test assert a
            // URL/query pair the shipped UI can no longer produce.
            statuses: [
              SessionStatusFacetValue.Active,
              SessionStatusFacetValue.Inactive,
            ],
            userIds: [],
            repositories: [],
          })
        }
        type="button"
      >
        Apply lifecycle filters
      </button>
    </div>
  ),
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

export function mockSessionsPageLoadingState() {
  useAgentSessionsMock.mockReturnValue({
    data: undefined,
    isLoading: true,
  });
  useAgentSessionsPageDataMock.mockReturnValue({
    data: undefined,
    isLoading: true,
    isLoadingError: false,
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
 * FEA-4177 (wongk): the list query's error state on an INITIAL rejection — no
 * data, `isError` true. The org sessions page reads `useAgentSessions`; return a
 * `refetch` spy so the Retry affordance's wiring is assertable.
 */
export function mockSessionsPageListErrorState(refetch: () => void) {
  useAgentSessionsMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch,
  });
  useAgentSessionUsageMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isLoadingError: true,
  });
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
 * ISS-5478: seeds `refetch` spies on the page's two reads (the list and the
 * summary aggregates), keeping the populated list the default state renders.
 * Without these the page calls `refetch()` on a mock that never had one, so a
 * re-read cannot be asserted at all.
 *
 * ISS-5975 (wongk review): the two reads also carry `isStale`/`isError`, because
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
