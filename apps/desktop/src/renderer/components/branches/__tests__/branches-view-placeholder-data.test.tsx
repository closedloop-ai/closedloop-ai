import {
  type BranchAnalytics,
  type BranchesPageData,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
} from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import {
  BRANCH_NAME_COLUMN_ID,
  branchColumnLabel,
} from "@repo/app/branches/lib/branch-column-view-model";
import { act, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

const { summaryCardsPropsMock, toolbarPropsMock } = vi.hoisted(() => ({
  summaryCardsPropsMock: vi.fn(),
  toolbarPropsMock: vi.fn(),
}));
const RETRY_BUTTON_NAME_PATTERN = /retry/i;

vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: (props: unknown) => {
    summaryCardsPropsMock(props);
    return null;
  },
}));

// ISS-8909: the v2 list surface is the only Branches arm, and it spreads this
// host's one toolbar prop set into `BranchesListToolbarV2`. The capture moved
// here from the retired v1 `BranchesToolbar`, which no longer renders.
vi.mock(
  "@repo/app/branches/components/branches-list-toolbar-v2",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/branches/components/branches-list-toolbar-v2")
    >()),
    BranchesListToolbarV2: (props: unknown) => {
      toolbarPropsMock(props);
      return null;
    },
  })
);

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => {
    const [dateRange, setDateRange] = useState<BranchDateRange>("90d");
    return { dateRange, setDateRange };
  },
}));

vi.mock("../use-desktop-github-connect", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../use-desktop-github-connect")>();
  return {
    ...actual,
    useDesktopGitHubConnect: () => ({
      connectState: actual.DesktopGitHubConnectState.Idle,
      connectGitHub: vi.fn(),
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // The cohort notice renders only while a visible row's Last active is
  // untrustworthy, which `resolveBranchCohortNotice` decides by comparing the
  // row against the local clock (ISS-10350 retired the echoed producer
  // instant). Freeze Date at this fixture's declared instant so the
  // deliberately one-day-ahead row keeps reading as future.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(RESPONSE_EVALUATION_NOW));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BranchesView server placeholder presentation (ISS-7197)", () => {
  it("withholds previous data through out-of-order responses and shows only the latest range", async () => {
    const sevenDay = deferredPageData();
    const thirtyDay = deferredPageData();
    const pageData = vi
      .fn<BranchesDataSource["pageData"]>()
      .mockResolvedValueOnce(serverPageData("feature/previous-90d"))
      .mockReturnValueOnce(sevenDay.promise)
      .mockReturnValueOnce(thirtyDay.promise);

    renderServerView(pageData);
    expect(await screen.findByText("feature/previous-90d")).toBeTruthy();

    selectRange("7d");
    expect(await screen.findByText("Loading branches…")).toBeTruthy();
    expect(screen.queryByText("feature/previous-90d")).toBeNull();
    expect(summaryCardsProps()).toMatchObject({
      analytics: undefined,
      isPending: true,
    });
    expect(toolbarProps()).toMatchObject({ facets: undefined, rows: [] });
    expect(
      screen.queryByRole("button", {
        name: branchColumnLabel(BRANCH_NAME_COLUMN_ID),
      })
    ).toBeNull();
    expect(screen.queryByText(NET_NEW_BANNER_COPY)).toBeNull();
    expect(screen.queryByText(COHORT_CLAIM_PATTERN)).toBeNull();
    expect(screen.queryByText("1–1 of 1")).toBeNull();

    selectRange("30d");
    await waitFor(() => expect(pageData).toHaveBeenCalledTimes(3));
    await act(async () => {
      thirtyDay.resolve(serverPageData("feature/latest-30d"));
      await thirtyDay.promise;
    });
    expect(await screen.findByText("feature/latest-30d")).toBeTruthy();
    expect(screen.queryByText("feature/obsolete-7d")).toBeNull();
    expect(screen.queryByText("feature/previous-90d")).toBeNull();
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(screen.getByRole("button", { name: "Name" })).toBeTruthy();
    expect(screen.queryByText(NET_NEW_BANNER_COPY)).toBeNull();
    expect(screen.queryByText(COHORT_CLAIM_PATTERN)).toBeNull();
    expect(screen.getByText("1–1 of 1")).toBeTruthy();
    expect(toolbarProps()).toMatchObject({
      facets: {
        names: {
          options: [
            { id: "feature/latest-30d", label: "feature/latest-30d", count: 1 },
          ],
        },
      },
    });

    await act(async () => {
      sevenDay.resolve(serverPageData("feature/obsolete-7d"));
      await sevenDay.promise;
    });
    expect(screen.getByText("feature/latest-30d")).toBeTruthy();
    expect(screen.queryByText("feature/obsolete-7d")).toBeNull();
    expect(screen.queryByText("feature/previous-90d")).toBeNull();
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(screen.getByText("1–1 of 1")).toBeTruthy();
    expect(screen.queryByText(NET_NEW_BANNER_COPY)).toBeNull();
  });

  it("shows error and Retry without restoring rejected previous-key data", async () => {
    const sevenDay = deferredPageData();
    const pageData = vi
      .fn<BranchesDataSource["pageData"]>()
      .mockResolvedValueOnce(serverPageData("feature/previous-90d"))
      .mockReturnValueOnce(sevenDay.promise);

    renderServerView(pageData);
    expect(await screen.findByText("feature/previous-90d")).toBeTruthy();
    selectRange("7d");
    expect(await screen.findByText("Loading branches…")).toBeTruthy();

    await act(async () => {
      sevenDay.reject(new Error("selected range unavailable"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Couldn't load branches")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME_PATTERN })
    ).toBeTruthy();
    expect(screen.queryByText("feature/previous-90d")).toBeNull();
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: branchColumnLabel(BRANCH_NAME_COLUMN_ID),
      })
    ).toBeNull();
    expect(screen.queryByText(NET_NEW_BANNER_COPY)).toBeNull();
    expect(screen.queryByText(COHORT_CLAIM_PATTERN)).toBeNull();
  });

  it("renders matching-key cached data when returning to the settled range", async () => {
    const sevenDay = deferredPageData();
    const pageData = vi
      .fn<BranchesDataSource["pageData"]>()
      .mockResolvedValueOnce(serverPageData("feature/cached-90d"))
      .mockReturnValueOnce(sevenDay.promise);

    renderServerView(pageData);
    expect(await screen.findByText("feature/cached-90d")).toBeTruthy();
    selectRange("7d");
    expect(await screen.findByText("Loading branches…")).toBeTruthy();

    selectRange("90d");
    expect(await screen.findByText("feature/cached-90d")).toBeTruthy();
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(pageData).toHaveBeenCalledTimes(2);
  });

  it("withholds previous legacy fallback rows during default range changes", async () => {
    const sevenDay = deferredPageData();
    const pageData = vi
      .fn<BranchesDataSource["pageData"]>()
      .mockResolvedValueOnce(legacyPageData("feature/legacy-90d"))
      .mockReturnValueOnce(sevenDay.promise);

    renderView({ ...baseDataSource, pageData });
    expect(await screen.findByText("feature/legacy-90d")).toBeTruthy();
    selectRange("7d");

    expect(await screen.findByText("Loading branches…")).toBeTruthy();
    expect(screen.queryByText("feature/legacy-90d")).toBeNull();
  });

  it("withholds a previous server page by default", async () => {
    const sevenDay = deferredPageData();
    const pageData = vi
      .fn<BranchesDataSource["pageData"]>()
      .mockResolvedValueOnce(serverPageData("feature/server-before-toggle"))
      .mockReturnValueOnce(sevenDay.promise);

    renderView({ ...baseDataSource, pageData });
    expect(
      await screen.findByText("feature/server-before-toggle")
    ).toBeTruthy();
    selectRange("7d");

    expect(await screen.findByText("Loading branches…")).toBeTruthy();
    expect(screen.queryByText("feature/server-before-toggle")).toBeNull();
    expect(screen.queryByText("1–1 of 1")).toBeNull();
  });

  /**
   * ISS-9887: this shell has to HAND the summary row the reload fact, not merely
   * happen to withhold the payload that would have carried it. The withholding
   * above and the fold in the row are two independent decisions, and the web page
   * reaches this same row from a path where the payload is NOT withheld — so if
   * the shell stopped passing this, desktop and web would answer the reload
   * question differently again with nothing failing.
   */
  it("tells the summary row the read is serving the previous scope", async () => {
    const sevenDay = deferredPageData();
    const pageData = vi
      .fn<BranchesDataSource["pageData"]>()
      .mockResolvedValueOnce(serverPageData("feature/previous-90d"))
      .mockReturnValueOnce(sevenDay.promise);

    renderServerView(pageData);
    expect(await screen.findByText("feature/previous-90d")).toBeTruthy();
    // Settled on the scope in view: nothing to disclose as a reload.
    expect(summaryCardsProps()).toMatchObject({ isReloading: false });

    selectRange("7d");
    expect(await screen.findByText("Loading branches…")).toBeTruthy();
    expect(summaryCardsProps()).toMatchObject({ isReloading: true });
  });
});

type BranchDateRange = "7d" | "30d" | "90d" | "all";

const baseDataSource: BranchesDataSource = {
  scope: "local",
  list: () => new Promise<never>(() => undefined),
  detail: () => new Promise<never>(() => undefined),
  comments: () => new Promise<never>(() => undefined),
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: () => Promise.resolve(null),
  pageData: () => new Promise<never>(() => undefined),
};

function renderServerView(pageData: BranchesDataSource["pageData"]): void {
  renderView({ ...baseDataSource, pageData }, undefined, [
    BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY,
  ]);
}

function selectRange(range: BranchDateRange): void {
  const onDateRangeChange = (
    toolbarProps() as {
      onDateRangeChange: (nextRange: BranchDateRange) => void;
    }
  ).onDateRangeChange;
  act(() => {
    onDateRangeChange(range);
  });
}

function summaryCardsProps(): unknown {
  return summaryCardsPropsMock.mock.lastCall?.[0];
}

function toolbarProps(): unknown {
  const props = toolbarPropsMock.mock.lastCall?.[0];
  if (!props) {
    throw new Error("Branches toolbar did not render");
  }
  return props;
}

function deferredPageData(): {
  promise: Promise<BranchesPageData>;
  resolve: (value: BranchesPageData) => void;
  reject: (reason: unknown) => void;
} {
  let resolvePromise: (value: BranchesPageData) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<BranchesPageData>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function serverPageData(branchName: string): BranchesPageData {
  const nameFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [{ id: branchName, label: branchName, count: 1 }],
  };
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    list: {
      items: [
        {
          ...wireRow,
          id: `owner%2Frepo::${branchName}`,
          branchName,
          lastActivityAt: ROW_LAST_ACTIVITY_AT,
          prNumber: null,
          prState: null,
          prTitle: null,
          prUrl: null,
        },
      ],
      total: 1,
      viewerScope: BranchViewerScope.Self,
      pageInfo: {
        capability: BranchListCapability.ServerPaginationV1,
        limit: BRANCH_LIST_SERVER_PAGE_SIZE,
        offset: 0,
        requestedOffset: 0,
        now: RESPONSE_EVALUATION_NOW,
      },
      facets: {
        names: nameFacet,
        owners: emptyFacet,
        collaborators: emptyFacet,
        statuses: emptyFacet,
        pullRequests: emptyFacet,
        lastActiveRanges: emptyFacet,
        repositories: emptyFacet,
        tags: emptyFacet,
      },
    },
    analytics: makeBranchAnalytics(),
  };
}

function legacyPageData(branchName: string): BranchesPageData {
  return {
    list: {
      items: [
        {
          ...wireRow,
          id: `owner%2Frepo::${branchName}`,
          branchName,
          lastActivityAt: ROW_LAST_ACTIVITY_AT,
          prNumber: null,
          prState: null,
          prTitle: null,
          prUrl: null,
        },
      ],
      total: 1,
      viewerScope: BranchViewerScope.Self,
    },
    analytics: makeBranchAnalytics(),
  };
}

// The instant this fixture pins the clock to, and a row one day ahead of it so
// its Last active reads as untrustworthy and the cohort notice has something
// truthful to claim.
const RESPONSE_EVALUATION_NOW = "2026-08-19T12:00:00.000Z";
const ROW_LAST_ACTIVITY_AT = "2026-08-20T12:00:00.000Z";
const COHORT_CLAIM_PATTERN =
  /Updating Branches for|Couldn't update Branches for/i;
const NET_NEW_BANNER_COPY =
  "These branches are tracked locally with no linked pull request yet — the metrics shown are net-new.";
