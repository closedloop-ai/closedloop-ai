import {
  BRANCH_PRIORITY_COLUMN_ID,
  branchColumnLabel,
} from "@repo/app/branches/lib/branch-column-view-model";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  makeBranchRow,
  makeListResponse,
  pageDataResult,
  renderBranchesPage as render,
  renderHeaderMock,
} from "./branches-page-fixtures";

/**
 * ISS-9225 — the WEB host's half of the v2 toolbar contract.
 *
 * `BranchesListSurfaceV2` composes `BranchesListToolbarV2` itself now, from one
 * prop set the host builds. A package-level mount with callback spies cannot
 * tell that apart from a host that assembles those props and never reaches the
 * toolbar with them (davetho), so this suite mounts the REAL page with
 * `grid-table-v2` on and drives the shipped control: hiding a column from the
 * Options menu has to remove the column from the table this page renders, and
 * "Reset view" has to bring it back. The desktop shell's mirror of this is
 * `apps/desktop/src/renderer/components/branches/__tests__/branches-view-grid-table-v2.test.tsx`,
 * and both shells are covered end to end by the Branches `grid-table-v2`
 * Playwright specs.
 */

const {
  apiPostMock,
  headerMock,
  navigationReplaceMock,
  searchParamsMock,
  useBranchCohortAnalyticsMock,
  useBranchesPageDataMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  headerMock: vi.fn(),
  navigationReplaceMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchCohortAnalyticsMock: vi.fn(),
  useBranchesPageDataMock: vi.fn(),
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
  usePath: () => "/acme/branches",
}));

// Stable identity, matching production: the page's backfill effect lists the
// client in its deps, so a fresh object per render would re-run it every render.
vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
  useGitHubIntegrationStatus: () => ({ data: undefined, isPending: false }),
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
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port. Closed and ready, matching this suite's other gates.
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
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
  useBranchesPageDataMock.mockReturnValue(
    pageDataResult({ list: makeListResponse([makeBranchRow()]) })
  );
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("PRD-721 AC-5 web Branches toolbar wiring (ISS-9225)", () => {
  it("offers wide Options without duplicate toolbar Sort", async () => {
    render(<BranchesPage />);

    await waitFor(() => expect(repositoryHeader()).toBeInTheDocument());
    expect(screen.getByRole("button", { name: OPTIONS })).toBeTruthy();
    expect(screen.queryByRole("button", { name: VIEW })).toBeNull();
    expect(screen.queryByRole("button", { name: RE_SORTED_BY })).toBeNull();
  });

  it("offers compact View and Sort below the measured breakpoint", async () => {
    const user = userEvent.setup();
    restoreWidth = stubContainerWidthPx(767);
    render(<BranchesPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: VIEW })).toBeInTheDocument()
    );
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByRole("button", { name: OPTIONS })).toBeNull();
    await user.click(screen.getByRole("button", { name: VIEW }));
    expect(await screen.findByText("Sorting", { exact: true })).toBeVisible();
  });

  it("hides a real column from the page's table and restores it with Reset view", async () => {
    const user = userEvent.setup();
    render(<BranchesPage />);

    await waitFor(() => expect(repositoryHeader()).toBeInTheDocument());

    await user.click(optionsTrigger());
    await user.click(await screen.findByRole("menuitem", REPOSITORY));

    // Close the menu BEFORE reading the table. Radix's dropdown is modal and
    // `aria-hidden`s the page behind it, so a columnheader query taken while it
    // is open returns null whether or not the toggle ever reached the table —
    // the assertion below would pass against a toolbar wired to nothing.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(repositoryHeader()).toBeNull());

    await user.click(optionsTrigger());
    await user.click(await screen.findByRole("menuitem", RESET_VIEW));
    await waitFor(() => expect(repositoryHeader()).toBeInTheDocument());
  });

  // ISS-10332 (#7762 review): the surface withholds Priority unless its host
  // opts in; web's source is the cloud list, so it opts in.
  it("offers the Priority column", async () => {
    const user = userEvent.setup();
    render(<BranchesPage />);

    await waitFor(() => expect(repositoryHeader()).toBeInTheDocument());
    expect(
      document.body.querySelector(PRIORITY_HEADER_SELECTOR)
    ).not.toBeNull();
    await user.click(optionsTrigger());
    expect(
      await screen.findByRole("menuitem", { name: PRIORITY_LABEL })
    ).toBeInTheDocument();
  });

  it("keeps the list region reachable as the region named 'Branches'", async () => {
    render(<BranchesPage />);

    await waitFor(() => expect(repositoryHeader()).toBeInTheDocument());
    // The v1 host spells this region `<section aria-label="Branches">`; v2
    // spells it `GridTableListSurface`'s scroll band carrying `role="region"`
    // with the same label. Playwright specs scope a row query to the list so
    // the facet menu (which lists the same branch names) cannot satisfy it —
    // addressed by ROLE, because a `section[…]` selector matches only the v1
    // spelling and scopes to NOTHING here, which reads as a page that rendered
    // no rows at all.
    expect(
      screen
        .getByRole("region", { name: BRANCHES_REGION })
        .querySelector(REPOSITORY_HEADER_SELECTOR)
    ).not.toBeNull();
  });
});

/** The wide cluster's Options trigger; the folded sibling is View. */
function optionsTrigger(): HTMLElement {
  const trigger = screen.getAllByRole("button", { name: OPTIONS })[0];
  if (!trigger) {
    throw new Error("The active Options control did not render");
  }
  return trigger;
}

/**
 * The header cell addressed by COLUMN ID, not accessible name (ISS-6065).
 *
 * Before ISS-11837 the browser composed the resize handle's and column-options
 * button's labels into this cell's accessible name, so a name query for
 * "Repository" resolved to nothing there and the `toBeNull()` assertion below
 * would have passed whether or not the toggle ever reached the table, while
 * jsdom rendered the bare label. The column id is the address that holds in
 * both and does not depend on how the header is named.
 */
function repositoryHeader(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(REPOSITORY_HEADER_SELECTOR);
}

const BRANCHES_REGION = "Branches";
const OPTIONS = "Options";
const VIEW = "View";
const RE_SORTED_BY = /^Sorted by/;
let restoreWidth: (() => void) | undefined;
const REPOSITORY_HEADER_SELECTOR =
  '[role="columnheader"][data-column-id="repo"]';
const PRIORITY_HEADER_SELECTOR = `[role="columnheader"][data-column-id="${BRANCH_PRIORITY_COLUMN_ID}"]`;
const PRIORITY_LABEL = branchColumnLabel(BRANCH_PRIORITY_COLUMN_ID);
const REPOSITORY = { name: "Repository" } as const;
const RESET_VIEW = { name: "Reset view" } as const;
