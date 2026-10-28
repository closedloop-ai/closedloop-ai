import {
  type BranchAnalytics,
  BranchStatus,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricValue,
  BranchMetricAvailability,
} from "@repo/api/src/types/branch-metrics";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

/**
 * ISS-9967 — the DESKTOP host picks the recomputing cohort binder, over a cohort
 * a facet actually narrowed.
 *
 * `packages/app/branches/lib/__tests__/filtered-cohort-recompute.test.ts` proves
 * the binder, and the web twin of this case lives in the Branches page suite.
 * Neither can prove that the Electron shell reaches for it: `branches-view.tsx`
 * chooses between four binders at its own flag read, so a host-specific gate or
 * a break in the filter wiring would leave both of those green while an enabled
 * reader still saw the fail-closed cards (davetho review).
 *
 * The existing desktop coverage for this key (`branches-zero-spend-card.test.tsx`)
 * mounts ONE row with no facet, which cannot tell a correct cohort filter from
 * no filter at all: with nothing narrowed the fallback never runs. So this file
 * mounts a MULTI-row corpus under a strict owner facet, and every expected
 * figure below differs from both the unfiltered answer and the producer's own,
 * so a binder reading the wrong population fails rather than coincides.
 *
 * The facet arrives from the URL — the path a shared link restores one through —
 * which exercises the host's real filter derivation without driving a menu this
 * file is not testing.
 */

const { openGitHubConnectMock, useDesktopAuthMock } = vi.hoisted(() => ({
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));

// Only the summary cards are under test; the table-side siblings are stubbed so
// the row text cannot satisfy an assertion meant for a card.
vi.mock("@repo/app/branches/components/branches-table", () => ({
  BranchesTable: () => null,
}));
// ISS-10301: the `BranchesToolbar` stub that used to live here named the v1
// component this ticket deleted, so it added a member `branches-toolbar-model`
// does not export and stood nothing down. The module is left unmocked — the live
// `BranchesListToolbarV2` reads `resolveBranchToolbarFacetGroups` from it, which
// the passthrough was really there to preserve.
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
// An all-time window keeps every fixture row visible regardless of wall clock,
// and is what makes the cohort request date-independent.
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({ dateRange: "all", setDateRange: vi.fn() }),
}));
vi.mock("@repo/app/branches/hooks/use-branch-view-state", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >();
  return {
    ...actual,
    useBranchViewState: () => ({
      // ISS-8127: the view gates presentation on this, so a stub omitting it
      // reads as "never restored" and withholds every row.
      isViewReady: true,
      sortKey: "updated",
      sortDir: "desc",
      dateRange: "all",
      visibleColumns: new Set<string>(["repo"]),
      setSort: vi.fn(),
      toggleSortDir: vi.fn(),
      setDateRange: vi.fn(),
      toggleColumn: vi.fn(),
    }),
  };
});

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost",
  });
  useDesktopAuthMock.mockReturnValue({
    state: {
      status: "authenticated",
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: vi.fn(),
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

const ADMITTED_OWNER = "alice";
const EXCLUDED_OWNER = "grace";
/** The strict facet under test, as a shared link would carry it. */
const FILTERED_PATH = `/branches?owner=${ADMITTED_OWNER}`;

/**
 * The admitted cohort: three merged single-PR branches sized 100/200/300 and one
 * closed branch. Median 200 (an ODD merged population, so the figure does not
 * depend on which convention `median` takes for an even one) and a merge rate of
 * three merged over four decided.
 */
const ADMITTED_MEDIAN_PR_SIZE = "200 LOC";
const ADMITTED_MERGE_RATE = "75%";
/**
 * What the same cards read if the facet were ignored and the whole list bound:
 * a median of 300 over five merged rows, and five merged of six decided. Pinned
 * as constants because their JOB is to differ from the admitted figures above —
 * that difference is what makes this fixture able to fail.
 */
const UNFILTERED_MEDIAN_PR_SIZE = "300 LOC";
const UNFILTERED_MERGE_RATE = "83.3%";
/**
 * The producer's own whole-list figures. Deliberately values no derivation over
 * these rows can produce, so a card showing one means the binder published the
 * producer's bundle untouched instead of recomputing.
 */
const PRODUCER_MEDIAN_PR_SIZE = "7 LOC";
const PRODUCER_MERGE_RATE = "11%";
/** The state the shipped fail-closed fallback renders, which this gate retires. */
const SUPPRESSED_BY_FILTER_DETAIL = "Not available with filters applied";

const MEDIAN_PR_SIZE_LABEL = "Median PR size";
const MERGE_RATE_LABEL = "Merge rate";

function branchRow(overrides: Partial<WireBranchRow>): WireBranchRow {
  return { ...wireRow, ...overrides };
}

/** A merged, single-PR, LOC-enriched branch of exactly `size` gross lines. */
function mergedRow(id: string, owner: string, size: number): WireBranchRow {
  return branchRow({
    id,
    owner,
    branchName: `feature/${id}`,
    status: BranchStatus.Merged,
    prState: GitHubPRState.Merged,
    additions: size / 2,
    deletions: size / 2,
    sessionIds: [`session-${id}`],
  });
}

const ADMITTED_ROWS = [
  mergedRow("alice-small", ADMITTED_OWNER, 100),
  mergedRow("alice-medium", ADMITTED_OWNER, 200),
  mergedRow("alice-large", ADMITTED_OWNER, 300),
  branchRow({
    id: "alice-closed",
    owner: ADMITTED_OWNER,
    branchName: "feature/alice-closed",
    status: BranchStatus.Closed,
    prState: GitHubPRState.Closed,
    additions: 10,
    deletions: 10,
    sessionIds: ["session-alice-closed"],
  }),
];
/** Excluded by the facet, and sized so leaving them in changes both figures. */
const EXCLUDED_ROWS = [
  mergedRow("grace-huge", EXCLUDED_OWNER, 2000),
  mergedRow("grace-larger", EXCLUDED_OWNER, 3000),
];
const ALL_ROWS = [...ADMITTED_ROWS, ...EXCLUDED_ROWS];

function complete(value: number): BranchListMetricValue {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  };
}

/**
 * A local source whose producer bundle carries figures for the WHOLE list and
 * which answers no cohort request.
 *
 * `cohortAnalytics` is deliberately absent rather than rejecting: the hook's
 * query function resolves to null when a source omits it, so the cohort read
 * SUCCEEDS with no answer. A rejection would instead trip the view's
 * `summaryAnalyticsErrored` guard and degrade every card, which would assert the
 * error path rather than the fallback this file is about.
 */
function filteredCohortSource(): BranchesDataSource {
  const list = {
    items: ALL_ROWS,
    total: ALL_ROWS.length,
    viewerScope: BranchViewerScope.Self,
    sessionCostUsd: Object.fromEntries(
      ALL_ROWS.map((row) => [`session-${row.id}`, 25])
    ),
  };
  const analytics = makeBranchAnalytics({
    canonicalMetrics: makeBranchListMetrics({
      cohortSize: ALL_ROWS.length,
      activeBranches: complete(9),
      medianPrSize: complete(7),
      mergeRatePct: complete(11),
    }),
  });
  return {
    scope: "local",
    list: () => Promise.resolve(list),
    detail: () => new Promise<never>(() => undefined),
    comments: () => new Promise<never>(() => undefined),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => new Promise<never>(() => undefined),
    analytics: () => new Promise<BranchAnalytics>(() => undefined),
    pageData: () => Promise.resolve({ list, analytics }),
  };
}

/** The card whose label contains `label`, or null when the row omits it. */
function cardFor(container: HTMLElement, label: string): HTMLElement | null {
  const cards = container.querySelectorAll<HTMLElement>('[data-slot="card"]');
  for (const card of cards) {
    const description = card.querySelector('[data-slot="card-description"]');
    if (description?.textContent?.includes(label)) {
      return card;
    }
  }
  return null;
}

/** The rendered VALUE of that card, read from the title slot alone. */
function cardValue(container: HTMLElement, label: string): string | null {
  const title = cardFor(container, label)?.querySelector(
    '[data-slot="card-title"]'
  );
  return title?.textContent?.trim() ?? null;
}

describe("BranchesView filtered-cohort recompute on the Electron shell (ISS-9967)", () => {
  it("re-derives Median PR size and Merge rate over the rows the facet left", async () => {
    const { container } = renderView(
      filteredCohortSource(),
      undefined,
      [],
      FILTERED_PATH
    );

    // Wait on the VALUE rather than the label: the pending row carries these
    // same labels over a "—", so settling on labels would assert the loading
    // state and pass whatever the resolved bundle turned out to hold.
    await waitFor(() =>
      expect(cardValue(container, MEDIAN_PR_SIZE_LABEL)).toBe(
        ADMITTED_MEDIAN_PR_SIZE
      )
    );
    expect(cardValue(container, MERGE_RATE_LABEL)).toBe(ADMITTED_MERGE_RATE);

    // The three populations this could have bound instead, each pinned so the
    // failure names which one it took: the whole list, or the producer's bundle
    // passed through untouched.
    const medianCard = cardFor(container, MEDIAN_PR_SIZE_LABEL)?.textContent;
    const mergeRateCard = cardFor(container, MERGE_RATE_LABEL)?.textContent;
    expect(medianCard).not.toContain(UNFILTERED_MEDIAN_PR_SIZE);
    expect(medianCard).not.toContain(PRODUCER_MEDIAN_PR_SIZE);
    expect(mergeRateCard).not.toContain(UNFILTERED_MERGE_RATE);
    expect(mergeRateCard).not.toContain(PRODUCER_MERGE_RATE);
    // Recomputed cards describe the cohort on screen, so nothing about them is
    // a filter refusal (ISS-9967 AC-3).
    expect(container.textContent).not.toContain(SUPPRESSED_BY_FILTER_DETAIL);
  });
});
