/**
 * ISS-7125: the Desktop list must hand `resolveBranchCohortNotice` the key of
 * the filter set it actually READ, not some other filter object in scope.
 *
 * `cohortKey` is a required parameter, so DELETING the argument fails
 * typecheck — but computing it wrong (from the toolbar `filters`, from a stale
 * variable, from `{}`) compiles, and every existing suite stays green because
 * none of them mounts the view against a producer cohort: the server fixtures
 * omit `lastActiveCohort` and set `total === items.length`, which makes
 * `completeCorpus` true and short-circuits the comparison entirely.
 *
 * So this mounts the real view over a bounded page (total > items.length) whose
 * producer keys the request it was handed — exactly what both producers do —
 * and reads the model the view composed. A wrong argument keys a different
 * request, the equality gate rejects the cohort, and the notice falls back to
 * the page-scoped undercount this ticket exists to remove.
 */

import type {
  BranchAnalytics,
  BranchListResponse,
  BranchQueryFilters,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortRequest } from "@repo/api/src/types/branch-analytics-cohort";
import {
  BranchListCohortScope,
  branchListCohortKey,
  completeBranchLastActiveCohort,
} from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
} from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import type { BranchCohortNoticeModel } from "@repo/app/branches/lib/branch-cohort-transparency";
import { BranchCohortNoticeKind } from "@repo/app/branches/lib/branch-cohort-transparency";
import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

const { cohortNoticeMock } = vi.hoisted(() => ({
  cohortNoticeMock: vi.fn(),
}));

vi.mock("@repo/app/branches/components/branch-cohort-notice", () => ({
  BranchCohortNotice: (props: { model: BranchCohortNoticeModel }) => {
    cohortNoticeMock(props);
    return null;
  },
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => {
    const [dateRange, setDateRange] = useState("90d");
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

// The server's own instant for the page, and a visible row that settled before
// it so the ROW-derived fallback would report a DIFFERENT model than the
// producer's — otherwise a wrong key could coincide with the right answer.
const RESPONSE_EVALUATION_NOW = "2026-08-19T12:00:00.000Z";
const ROW_LAST_ACTIVITY_AT = "2026-08-19T06:00:00.000Z";
const CORPUS_TOTAL = 3;
const CORPUS_RETAINED_UNAVAILABLE = 1;
const ROW_BRANCH_NAME = "feature/bounded-page";

beforeEach(() => {
  vi.clearAllMocks();
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

describe("BranchesView producer-cohort wiring (ISS-7125)", () => {
  it("keys the cohort comparison from the filter set it read", async () => {
    const list = vi
      .fn<BranchesDataSource["list"]>()
      .mockImplementation((filters) =>
        Promise.resolve(boundedServerPage(filters))
      );

    renderView({
      ...baseDataSource,
      supportsSplitPageData: true,
      analytics: () => Promise.resolve(makeBranchAnalytics()),
      list,
    });

    expect(await screen.findByText(ROW_BRANCH_NAME)).toBeTruthy();
    await waitFor(() => expect(cohortNoticeMock).toHaveBeenCalled());
    expect(lastCohortNoticeModel()).toEqual({
      kind: BranchCohortNoticeKind.Complete,
      total: CORPUS_TOTAL,
      knownInWindow: CORPUS_TOTAL - CORPUS_RETAINED_UNAVAILABLE,
      retainedUnavailable: CORPUS_RETAINED_UNAVAILABLE,
    });
  });
});

const baseDataSource: BranchesDataSource = {
  scope: "local",
  list: () => new Promise<never>(() => undefined),
  detail: () => new Promise<never>(() => undefined),
  comments: () => new Promise<never>(() => undefined),
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: (_request: BranchAnalyticsCohortRequest) =>
    Promise.resolve(null),
  pageData: () => new Promise<never>(() => undefined),
};

function lastCohortNoticeModel(): BranchCohortNoticeModel {
  const props = cohortNoticeMock.mock.lastCall?.[0] as
    | { model: BranchCohortNoticeModel }
    | undefined;
  if (!props) {
    throw new Error("Branch cohort notice did not render");
  }
  return props.model;
}

/**
 * One bounded server page whose cohort is keyed on the request the producer was
 * handed — the same `branchListCohortKey(request)` both the Desktop main and
 * the cloud list stamp. `total` deliberately exceeds the page's row count, so
 * `completeCorpus` is false and the producer comparison actually runs.
 */
function boundedServerPage(filters: BranchQueryFilters): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    items: [
      {
        ...wireRow,
        id: `owner%2Frepo::${ROW_BRANCH_NAME}`,
        branchName: ROW_BRANCH_NAME,
        lastActivityAt: ROW_LAST_ACTIVITY_AT,
        prNumber: null,
        prState: null,
        prTitle: null,
        prUrl: null,
      },
    ],
    total: CORPUS_TOTAL,
    hasMore: true,
    viewerScope: BranchViewerScope.Self,
    lastActiveCohort: completeBranchLastActiveCohort({
      scope: BranchListCohortScope.RequestFilters,
      cohortKey: branchListCohortKey(filters),
      evaluationNow: new Date(RESPONSE_EVALUATION_NOW),
      total: CORPUS_TOTAL,
      retainedUnavailable: CORPUS_RETAINED_UNAVAILABLE,
    }),
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      requestedOffset: 0,
      now: RESPONSE_EVALUATION_NOW,
    },
    facets: {
      names: {
        availability: BranchListFacetAvailability.Complete,
        options: [{ id: ROW_BRANCH_NAME, label: ROW_BRANCH_NAME, count: 1 }],
      },
      owners: emptyFacet,
      collaborators: emptyFacet,
      statuses: emptyFacet,
      pullRequests: emptyFacet,
      lastActiveRanges: emptyFacet,
      repositories: emptyFacet,
      tags: emptyFacet,
    },
  };
}
