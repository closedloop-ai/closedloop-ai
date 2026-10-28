/**
 * ISS-9544 — the WEB half of the Branches both-host contract.
 *
 * The states asserted here are not written here: they live once in
 * `@repo/app/branches/__tests__/branches-both-host-contract`, and
 * `apps/desktop/src/renderer/components/branches/__tests__/branches-both-host-contract.test.tsx`
 * runs the identical cases over identical fixtures against the Electron shell.
 * This file owns only the web ADAPTER: this app's providers, its PostHog gates,
 * and the org-slug route the desktop shell has no analogue for.
 *
 * A shared-surface change that holds here and not there is the defect class
 * PRD-711 keeps re-finding; the pair is what makes "does it hold on both?"
 * answerable without running the whole desktop suite.
 */

import {
  BRANCHES_BOTH_HOST_CONTRACT,
  type BranchesBothHostFixture,
  CONTRACT_ORG_SLUG,
} from "@repo/app/branches/__tests__/branches-both-host-contract";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  runBothHostContract,
  WEB_HOST,
} from "@repo/app/shared/testing/both-host-render-contract";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  makeListResponse,
  pageDataResult,
  renderBranchesPage as render,
  renderHeaderMock,
} from "./branches-page-fixtures";

const {
  apiPostMock,
  headerMock,
  navigationReplaceMock,
  searchParamsMock,
  useBranchCohortAnalyticsMock,
  useBranchesPageDataMock,
  useGitHubIntegrationStatusMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  headerMock: vi.fn(),
  navigationReplaceMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchCohortAnalyticsMock: vi.fn(),
  useBranchesPageDataMock: vi.fn(),
  useGitHubIntegrationStatusMock: vi.fn(),
}));
const { enabledFlags } = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
}));
const { cohortRefetchMock, invalidateQueriesMock } = vi.hoisted(() => ({
  cohortRefetchMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
}));
vi.mock("@datadog/browser-rum", () => ({
  datadogRum: { setViewContextProperty: vi.fn() },
}));

vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  branchesKeys: {
    all: ["branches"],
    analyticsRoot: () => ["branches", "analytics"],
    cohortAnalyticsRoot: () => ["branches", "cohort-analytics"],
    pageDataRoot: () => ["branches", "page-data"],
  },
  useBranchCohortAnalytics: useBranchCohortAnalyticsMock,
  useBranchesPageData: useBranchesPageDataMock,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
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
  usePath: () => `/${CONTRACT_ORG_SLUG}/branches`,
}));

// Stable identity, matching production: the page's backfill effect lists the
// client in its deps, so a fresh object per render would re-run it every render.
vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
  useGitHubIntegrationStatus: useGitHubIntegrationStatusMock,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  const queryClient = { invalidateQueries: invalidateQueriesMock };
  return {
    ...actual,
    useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
    useQueryClient: () => queryClient,
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: enabledFlags.has(key),
    isReady: true,
    isResolved: true,
  }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => CONTRACT_ORG_SLUG,
}));

// Radix's dropdown reads the pointer-capture API jsdom does not implement.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

beforeEach(() => {
  headerMock.mockReset();
  headerMock.mockImplementation(renderHeaderMock);
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({});
  searchParamsMock.mockReset();
  searchParamsMock.mockReturnValue(new URLSearchParams());
  navigationReplaceMock.mockReset();
  invalidateQueriesMock.mockReset();
  cohortRefetchMock.mockReset();
  useBranchCohortAnalyticsMock.mockReset();
  useBranchCohortAnalyticsMock.mockReturnValue({
    data: null,
    isError: false,
    isPending: false,
    refetch: cohortRefetchMock,
  });
  useBranchesPageDataMock.mockReset();
  useGitHubIntegrationStatusMock.mockReset();
  useGitHubIntegrationStatusMock.mockReturnValue({
    data: { connected: true },
    isPending: false,
  });
  enabledFlags.clear();
  enabledFlags.add(GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY);
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

runBothHostContract<BranchesBothHostFixture>({
  contract: BRANCHES_BOTH_HOST_CONTRACT,
  host: WEB_HOST,
  mount: (fixture) => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse([...fixture.rows]) })
    );
    render(<BranchesPage />);
  },
});

it("keeps shared adoption active while GitHub status is unresolved", async () => {
  const fixture = BRANCHES_BOTH_HOST_CONTRACT.cases[0].fixture;
  useGitHubIntegrationStatusMock.mockReturnValue({
    data: undefined,
    isPending: true,
  });
  useBranchesPageDataMock.mockReturnValue(
    pageDataResult({ list: makeListResponse([...fixture.rows]) })
  );

  const result = render(<BranchesPage />);

  expect(await result.findByText(fixture.rows[0]!.branchName)).toBeVisible();
  expect(
    result.container.querySelector('[data-grid-row-id="__grid-chrome__header"]')
  ).not.toBeNull();
  expect(
    await result.findAllByRole("button", { name: "Branch actions" })
  ).not.toHaveLength(0);
});
