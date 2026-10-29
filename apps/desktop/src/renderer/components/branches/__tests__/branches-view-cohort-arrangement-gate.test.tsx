/**
 * ISS-8127 (davetho review): the Desktop Branches surface must not ask the
 * cohort producer about the window it is holding BEFORE a restored named saved
 * view has been applied.
 *
 * `isViewReady` settles when the branches view-state extras restore, and on
 * Desktop the window does not live there at all — it comes from the shared
 * `useSharedDateRange` store. A named active view's range lands one commit
 * later still, through `applySavedArrangement`. With a WARM cache the rows are
 * already on hand across that gap, so gating only the PRESENTATION left the
 * producer reachable under the initial range, which is the wrong-cohort path
 * this ticket exists to close.
 */

import type {
  BranchAnalytics,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortRequest } from "@repo/api/src/types/branch-analytics-cohort";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { DEFAULT_BRANCH_FILTERS } from "@repo/app/branches/lib/branch-row";
import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

const { cohortAnalyticsMock, savedViewsApplyMock, sharedDateRangeMock } =
  vi.hoisted(() => ({
    cohortAnalyticsMock: vi.fn(),
    savedViewsApplyMock: vi.fn(),
    sharedDateRangeMock: vi.fn(),
  }));

// Mutable so one case can drive the gate open mid-test. Default TRUE so a stub
// omission can never quietly withhold every cohort request in this file.
let arrangementSettled = true;

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => sharedDateRangeMock(),
}));

vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  // The view now restores the collection one hook earlier so the read gate can
  // see it (ISS-9447 review).
  useBranchSavedViewsStore: () => ({ isArrangementSettled: true }),
  useBranchSavedViews: (
    _store: unknown,
    _snapshot: unknown,
    apply: unknown
  ) => {
    savedViewsApplyMock(apply);
    return {
      views: [],
      activeViewId: null,
      modified: false,
      isArrangementSettled: arrangementSettled,
      onSelectView: vi.fn(),
      onCreateView: vi.fn(),
      onUpdateView: vi.fn(),
      onRenameView: vi.fn(),
      onDeleteView: vi.fn(),
    };
  },
}));

const DAY_MS = 86_400_000;
const RECENT_ROW_COUNT = 3;
const CORPUS_SIZE = 12;
const SETTLED_RANGE = "all";
const INITIAL_RANGE = "7d";

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
  arrangementSettled = true;
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
  cohortAnalyticsMock.mockImplementation(
    (request: BranchAnalyticsCohortRequest) =>
      Promise.resolve({
        matchedBranchIds: request.branchIds,
        canonicalMetrics: null,
      })
  );
});

describe("BranchesView cohort arrangement gate (ISS-8127)", () => {
  it("asks the producer only once the saved arrangement is applied, never under the initial range", async () => {
    const corpus = windowSpanningCorpus();
    // The INITIAL range, deliberately narrower than the saved one applied
    // below, so a cohort built before settlement is a strict subset of the
    // corpus rather than an equal set the assertion could not tell apart.
    setSharedRange(INITIAL_RANGE);
    arrangementSettled = false;

    renderView(dataSourceFor(corpus));
    await screen.findByText("feature/cohort-1");
    const apply = savedViewsApplyMock.mock.calls.at(-1)?.[0] as
      | { applyFilters: (filters: typeof DEFAULT_BRANCH_FILTERS) => void }
      | undefined;
    act(() => {
      apply?.applyFilters({ ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] });
    });

    // `act` flushed the effects, so an open gate would already have asked.
    expect(cohortAnalyticsMock).not.toHaveBeenCalled();

    setSharedRange(SETTLED_RANGE);
    arrangementSettled = true;
    act(() => {
      apply?.applyFilters({ ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] });
    });

    await waitFor(() => expect(cohortAnalyticsMock).toHaveBeenCalled());
    for (const [request] of cohortAnalyticsMock.mock.calls as [
      BranchAnalyticsCohortRequest,
    ][]) {
      expect(request.branchIds).toHaveLength(CORPUS_SIZE);
    }
  });
});

function setSharedRange(dateRange: string): void {
  sharedDateRangeMock.mockReturnValue({
    dateRange,
    setDateRange: vi.fn(),
  });
}

/**
 * A corpus straddling the initial window: only the first
 * {@link RECENT_ROW_COUNT} rows fall inside it, so a request built before the
 * saved arrangement lands carries a strict subset the assertion can name.
 */
function windowSpanningCorpus(): (typeof wireRow)[] {
  const now = Date.now();
  return Array.from({ length: CORPUS_SIZE }, (_, index) => ({
    ...wireRow,
    id: `owner%2Frepo::cohort-${index + 1}`,
    branchName: `feature/cohort-${index + 1}`,
    owner: "alice",
    sessionIds: [`session-${index + 1}`],
    lastActivityAt: new Date(
      now - (index < RECENT_ROW_COUNT ? index + 1 : index + 40) * DAY_MS
    ).toISOString(),
  }));
}

function dataSourceFor(items: (typeof wireRow)[]): BranchesDataSource {
  return {
    scope: "local",
    list: listFor(items),
    detail: () => new Promise<never>(() => undefined),
    comments: () => new Promise<never>(() => undefined),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => new Promise<BranchUsageSummary>(() => undefined),
    analytics: () => new Promise<BranchAnalytics>(() => undefined),
    cohortAnalytics: cohortAnalyticsMock,
    pageData: async () => ({
      list: await listFor(items)(),
      analytics: makeBranchAnalytics(),
    }),
  } as unknown as BranchesDataSource;
}

function listFor(items: (typeof wireRow)[]) {
  return () =>
    Promise.resolve({
      items,
      total: items.length,
      viewerScope: BranchViewerScope.Self,
    });
}
