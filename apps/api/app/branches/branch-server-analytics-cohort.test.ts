import {
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchListQuery } from "./branch-list-query";

const mocks = vi.hoisted(() => ({
  getBranchCandidateSnapshots: vi.fn(),
  getBranchRowsById: vi.fn(),
  getBranchAnalyticsRows: vi.fn(),
  projectBranchListRows: vi.fn(),
}));

vi.mock("@repo/observability/tracing/spans", () => ({
  setAppSpanAttributes: vi.fn(),
  withAppSpan: (_name: string, callback: () => unknown) => callback(),
}));

vi.mock("./branch-candidate-read", () => ({
  getBranchCandidateSnapshots: mocks.getBranchCandidateSnapshots,
}));

vi.mock("./branch-list-projection", () => ({
  projectBranchListRows: mocks.projectBranchListRows,
}));

vi.mock("./branch-read-service/persisted-row-read", async (importOriginal) => {
  // Only the two reads are mocked. `selectRowsInIdOrder` is a pure ordering
  // helper and `asBranchAnalyticsRow` is the production identity, so the rows
  // this suite hands back from the projection arm are the same objects the
  // list read produced — that is exactly what these tests assert.
  const actual =
    await importOriginal<
      typeof import("./branch-read-service/persisted-row-read")
    >();
  return {
    ...actual,
    getBranchAnalyticsRows: mocks.getBranchAnalyticsRows,
    getBranchRowsById: mocks.getBranchRowsById,
  };
});

import { loadBranchAnalyticsRowCohorts } from "./branch-read-service/analytics-row-cohorts";
import { getBranchServerAnalyticsRows } from "./branch-server-analytics-cohort";

describe("getBranchServerAnalyticsRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBranchCandidateSnapshots.mockResolvedValue([
      candidate("branch-1"),
      candidate("branch-2"),
    ]);
    mocks.getBranchRowsById.mockResolvedValue([
      branchRow("branch-1"),
      branchRow("branch-2"),
    ]);
    mocks.projectBranchListRows.mockResolvedValue({
      items: [branchRow("branch-2"), branchRow("branch-1")],
    });
    mocks.getBranchAnalyticsRows.mockImplementation(
      async (_db, _organizationId, branchIds) =>
        branchIds.map((id: string) => analyticsRow(id))
    );
  });

  it("hydrates analytics directly from candidate order for default server analytics", async () => {
    const result = await getBranchServerAnalyticsRows(
      db(),
      "org-1",
      query({ startDate: new Date("2026-05-01T00:00:00.000Z") }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchRowsById).not.toHaveBeenCalled();
    expect(mocks.projectBranchListRows).not.toHaveBeenCalled();
    expect(mocks.getBranchAnalyticsRows).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      ["branch-1", "branch-2"],
      [candidate("branch-1"), candidate("branch-2")]
    );
    expect(result.map((row) => row.id)).toEqual(["branch-1", "branch-2"]);
  });

  it("pins candidate selection to the operation clock when query omits evaluationNow", async () => {
    await getBranchServerAnalyticsRows(
      db(),
      "org-1",
      query({ startDate: new Date("2026-05-01T00:00:00.000Z") }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        evaluationNow: new Date("2026-08-20T12:00:00.000Z"),
      })
    );
  });

  it("uses projected rows when LOC filters need row-derived totals", async () => {
    const belowLocMinRow = {
      ...branchRow("branch-3"),
      additions: 5,
      deletions: 0,
    };
    const aboveLocMaxRow = {
      ...branchRow("branch-4"),
      additions: 300,
      deletions: 0,
    };
    mocks.getBranchCandidateSnapshots.mockResolvedValueOnce([
      candidate("branch-1"),
      candidate("branch-2"),
      candidate("branch-3"),
      candidate("branch-4"),
    ]);
    mocks.getBranchRowsById.mockResolvedValueOnce([
      branchRow("branch-1"),
      branchRow("branch-2"),
      belowLocMinRow,
      aboveLocMaxRow,
    ]);
    mocks.projectBranchListRows.mockResolvedValueOnce({
      items: [
        branchRow("branch-2"),
        belowLocMinRow,
        aboveLocMaxRow,
        branchRow("branch-1"),
      ],
    });

    const result = await getBranchServerAnalyticsRows(
      db(),
      "org-1",
      query({ [BRANCH_LOC_MIN_PARAM]: 10, [BRANCH_LOC_MAX_PARAM]: 200 }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchRowsById).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      ["branch-1", "branch-2", "branch-3", "branch-4"],
      [
        candidate("branch-1"),
        candidate("branch-2"),
        candidate("branch-3"),
        candidate("branch-4"),
      ]
    );
    expect(mocks.projectBranchListRows).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      [
        branchRow("branch-1"),
        branchRow("branch-2"),
        belowLocMinRow,
        aboveLocMaxRow,
      ],
      expect.objectContaining({
        [BRANCH_LOC_MIN_PARAM]: 10,
        [BRANCH_LOC_MAX_PARAM]: 200,
      }),
      undefined,
      { includeAttributedCost: false }
    );
    // ISS-9111: the rows the projection already hydrated ARE the analytics
    // rows, so this arm issues no second artifact read.
    expect(mocks.getBranchAnalyticsRows).not.toHaveBeenCalled();
    // A removed read is only removed while nothing re-issues it under another
    // name: every `toHaveBeenCalledWith` above still passes if its collaborator
    // runs twice, so the exact counts — not the arguments — are what pin the
    // redundant read out. The arm resolves the cohort from ONE candidate scan,
    // ONE row hydration, and ONE list projection; a second call would also
    // resolve it against a later database state.
    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.getBranchRowsById).toHaveBeenCalledTimes(1);
    expect(mocks.projectBranchListRows).toHaveBeenCalledTimes(1);
    expect(result.map((row) => row.id)).toEqual(["branch-1", "branch-2"]);
  });

  it("uses projected rows when server-only filters need row-derived fields", async () => {
    const hydratedTwo = branchRow("branch-2");
    mocks.getBranchRowsById.mockResolvedValueOnce([
      branchRow("branch-1"),
      hydratedTwo,
    ]);

    const result = await getBranchServerAnalyticsRows(
      db(),
      "org-1",
      query({ names: ["branch-2"] }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchRowsById).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      ["branch-1", "branch-2"],
      [candidate("branch-1"), candidate("branch-2")]
    );
    expect(mocks.projectBranchListRows).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      [branchRow("branch-1"), branchRow("branch-2")],
      expect.objectContaining({ names: ["branch-2"] }),
      undefined,
      { includeAttributedCost: false }
    );
    expect(mocks.getBranchAnalyticsRows).not.toHaveBeenCalled();
    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.getBranchRowsById).toHaveBeenCalledTimes(1);
    expect(mocks.projectBranchListRows).toHaveBeenCalledTimes(1);
    expect(result.map((row) => row.id)).toEqual(["branch-2"]);
    // The returned row is the hydrated LIST row itself, not a re-read of it.
    // Reusing that object is what removes the second query, so identity — not
    // just a matching id — is what a reintroduced narrow read would break.
    expect(result[0]).toBe(hydratedTwo);
  });

  it("uses candidate order when only sorting diverges because analytics is order-insensitive", async () => {
    await getBranchServerAnalyticsRows(
      db(),
      "org-1",
      query({
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchRowsById).not.toHaveBeenCalled();
    expect(mocks.projectBranchListRows).not.toHaveBeenCalled();
    expect(mocks.getBranchAnalyticsRows).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      ["branch-1", "branch-2"],
      [candidate("branch-1"), candidate("branch-2")]
    );
  });
});

/**
 * ISS-9111: a date-windowed server-analytics request with a projection facet
 * resolves TWO date arms, and each used to run its own corpus-wide candidate
 * scan and its own corpus-wide list-row hydration. Both are now read once.
 *
 * The expected counts are literals for what one request may issue — 1 candidate
 * scan, 1 list hydration — not values derived from the corpus or from the code
 * under test. The corpus sizes bracket the point: a fixture small enough to
 * scan twice unnoticed, and one large enough that the second scan is the whole
 * eligible corpus again.
 */
describe("loadBranchAnalyticsRowCohorts server scope reads", () => {
  it("shares successful lifetime identity evidence while projecting each date window separately", async () => {
    const identityData = {
      windowed: new Map(),
      lifetime: new Map(),
      identityByBranch: new Map(),
    };
    mocks.getBranchCandidateSnapshots.mockResolvedValue([
      candidate("branch-0"),
    ]);
    mocks.getBranchRowsById.mockResolvedValue([branchRow("branch-0")]);
    mocks.projectBranchListRows.mockImplementation(
      (_db, _org, rows, _query, _tags, options) => {
        options.onIdentityData?.(identityData);
        return Promise.resolve({ items: rows });
      }
    );
    await loadBranchAnalyticsRowCohorts(
      db() as Parameters<typeof loadBranchAnalyticsRowCohorts>[0],
      "org-1",
      query({
        startDate: new Date("2026-08-01T00:00:00Z"),
        names: ["branch-0"],
      }),
      "2026-08-20T12:00:00Z"
    );
    const calls = mocks.projectBranchListRows.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][3].startDate).toBeUndefined();
    expect(calls[1][3].startDate).toEqual(new Date("2026-08-01T00:00:00Z"));
    expect(calls[1][5].preloadedIdentityData).toBe(identityData);
  });

  it("does not invent preloaded evidence when the canonical identity read is unavailable", async () => {
    mocks.getBranchCandidateSnapshots.mockResolvedValue([
      candidate("branch-0"),
    ]);
    mocks.getBranchRowsById.mockResolvedValue([branchRow("branch-0")]);
    mocks.projectBranchListRows.mockImplementation(async (_db, _org, rows) => ({
      items: rows,
    }));
    await loadBranchAnalyticsRowCohorts(
      db() as Parameters<typeof loadBranchAnalyticsRowCohorts>[0],
      "org-1",
      query({
        startDate: new Date("2026-08-01T00:00:00Z"),
        names: ["branch-0"],
      }),
      "2026-08-20T12:00:00Z"
    );
    expect(
      mocks.projectBranchListRows.mock.calls[1][5].preloadedIdentityData
    ).toBeUndefined();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([2, 60])(
    "reads the candidate scope and the list rows once for a %i-branch corpus",
    async (corpusSize) => {
      const ids = Array.from(
        { length: corpusSize },
        (_unused, index) => `branch-${index}`
      );
      mocks.getBranchCandidateSnapshots.mockResolvedValue(ids.map(candidate));
      mocks.getBranchRowsById.mockResolvedValue(ids.map(branchRow));
      mocks.projectBranchListRows.mockImplementation(
        async (_db: unknown, _organizationId: string, rows: unknown[]) => ({
          items: rows,
        })
      );
      mocks.getBranchAnalyticsRows.mockImplementation(
        async (_db: unknown, _organizationId: string, branchIds: string[]) =>
          branchIds.map(analyticsRow)
      );

      await loadBranchAnalyticsRowCohorts(
        db() as Parameters<typeof loadBranchAnalyticsRowCohorts>[0],
        "org-1",
        query({
          startDate: new Date("2026-08-01T00:00:00.000Z"),
          names: ["branch-0"],
        }),
        "2026-08-20T12:00:00.000Z"
      );

      expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledTimes(1);
      expect(mocks.getBranchRowsById).toHaveBeenCalledTimes(1);
      // The list PROJECTION is date-window sensitive (`sessionUsageDateWindow`
      // feeds each row's windowed usage), so it is NOT shared between the arms
      // — stated here so a future change cannot quietly collapse it and serve
      // the windowed arm a canonical-window row.
      expect(mocks.projectBranchListRows).toHaveBeenCalledTimes(2);
    }
  );
});

function db(): Parameters<typeof getBranchServerAnalyticsRows>[0] {
  return {} as Parameters<typeof getBranchServerAnalyticsRows>[0];
}

function query(overrides: Partial<BranchListQuery> = {}): BranchListQuery {
  return {
    limit: 20,
    offset: 0,
    pageMode: BranchListPageMode.Server,
    ...overrides,
  };
}

function candidate(id: string) {
  return {
    id,
    repositorySortKey: "closedloop-ai/closedloop-ai",
    branchSortKey: id,
    activityAtom: null,
  };
}

function branchRow(id: string) {
  return {
    id,
    branchName: id,
    status: BranchStatus.Open,
    sessionIds: [],
    canonicalProjection: null,
    canonicalLastActiveAt: undefined,
    repoFullName: "closedloop-ai/closedloop-ai",
    owner: null,
    ownerIdentity: null,
    collaborators: null,
    prNumber: null,
    additions: 80,
    deletions: 20,
    tags: [],
    tagAvailability: "complete",
  };
}

function analyticsRow(id: string) {
  return {
    id,
    status: BranchStatus.Open,
    projectId: null,
    pullRequestDetails: [],
    branch: {
      repositoryId: null,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      repository: null,
      firstPushedAt: null,
      pushSource: null,
      activityAtoms: [],
      headSha: null,
      headShaSource: null,
      headShaObservedAt: null,
      branchName: id,
      fileCacheStatus: null,
      fileCacheHeadSha: null,
      fileCacheCapped: null,
      fileCacheFileCount: null,
      fileChanges: [],
    },
  };
}
