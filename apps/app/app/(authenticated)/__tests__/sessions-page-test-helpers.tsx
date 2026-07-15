import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type { ReactNode } from "react";
import { type Mock, vi } from "vitest";

const {
  navigationReplaceMock,
  pathnameMock,
  searchParamsMock,
  sessionsTotalMock,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
} = vi.hoisted<{
  navigationReplaceMock: Mock;
  pathnameMock: { value: string };
  searchParamsMock: URLSearchParams;
  sessionsTotalMock: { value: number };
  useAgentSessionsMock: Mock;
  useAgentSessionUsageMock: Mock;
}>(() => ({
  navigationReplaceMock: vi.fn(),
  pathnameMock: { value: "/sessions" },
  searchParamsMock: new URLSearchParams(),
  sessionsTotalMock: { value: 1 },
  useAgentSessionsMock: vi.fn(),
  useAgentSessionUsageMock: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: useAgentSessionsMock,
  useAgentSessionUsage: useAgentSessionUsageMock,
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
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

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: ({
    onFiltersChange,
  }: {
    onFiltersChange: (next: {
      statuses: string[];
      userIds: string[];
      repositories: string[];
    }) => void;
  }) => (
    <div>
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
            statuses: [
              SESSION_STATUS.ACTIVE,
              SESSION_STATUS.COMPLETED,
              SESSION_STATUS.ABANDONED,
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

export const defaultSessionsPageHookArgs = {
  harness: undefined,
  limit: 25,
  offset: 0,
  status: undefined,
  userId: undefined,
};

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

/** Args of the most recent Sessions history-table query (skips the panel). */
export function lastSessionsTableCallArgs():
  | Record<string, unknown>
  | undefined {
  const { calls } = useAgentSessionsMock.mock;
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
export const sessionsEmptyTitle = "No sessions found";
export const sessionsEmptyDescription =
  "No synced sessions match your current filters yet.";

export {
  navigationReplaceMock,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
};

export function resetSessionsPageTestState(viewerScope: ViewerScope) {
  navigationReplaceMock.mockReset();
  pathnameMock.value =
    viewerScope === "organization" ? "/acme/sessions" : "/sessions";
  sessionsTotalMock.value = DEFAULT_TOTAL;
  searchParamsMock.delete("page");
  searchParamsMock.delete("userId");
  useAgentSessionsMock.mockReset();
  useAgentSessionsMock.mockImplementation((args: unknown) =>
    isSessionsTableQuery(args)
      ? {
          data: {
            items: [createAgentSessionListItemFixture()],
            total: sessionsTotalMock.value,
            viewerScope,
          },
          isLoading: false,
        }
      : { data: { items: [], total: 0, viewerScope }, isLoading: false }
  );
  useAgentSessionUsageMock.mockReset();
  useAgentSessionUsageMock.mockReturnValue({
    data: { totalSessions: 1, totalEstimatedCost: 0 },
    isLoading: false,
  });
}

export function setSelectedSessionUser(userId: string) {
  searchParamsMock.set("userId", userId);
}

export function setSessionsPageQuery(page: string) {
  searchParamsMock.set("page", page);
}

export function clearSessionsPageQuery() {
  searchParamsMock.delete("page");
}

export function setSessionsTotal(total: number) {
  sessionsTotalMock.value = total;
  useAgentSessionsMock.mockImplementation((args: unknown) =>
    isSessionsTableQuery(args)
      ? {
          data: {
            items: [createAgentSessionListItemFixture()],
            total: sessionsTotalMock.value,
          },
          isLoading: false,
        }
      : { data: { items: [], total: 0 }, isLoading: false }
  );
}

export function mockSessionsPageLoadingState() {
  useAgentSessionsMock.mockReturnValue({
    data: undefined,
    isLoading: true,
  });
}

export function mockSessionsPageEmptyState(viewerScope: ViewerScope) {
  useAgentSessionsMock.mockReturnValue({
    data: {
      items: [],
      total: 0,
      viewerScope,
    },
    isLoading: false,
  });
}
