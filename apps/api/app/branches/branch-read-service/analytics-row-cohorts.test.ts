import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchListOperationQuery } from "../branch-list-query";
import { loadBranchAnalyticsRowCohorts } from "./analytics-row-cohorts";

const mocks = vi.hoisted(() => ({
  getBranchAnalyticsRows: vi.fn(),
  getBranchCandidateSnapshots: vi.fn(),
  getBranchRowsById: vi.fn(),
  getBranchServerAnalyticsRows: vi.fn(),
  branchAnalyticsQuerySpanAttributes: vi.fn().mockReturnValue({}),
  setAppSpanAttributes: vi.fn(),
}));

vi.mock("@repo/observability/tracing/spans", () => ({
  setAppSpanAttributes: mocks.setAppSpanAttributes,
  withAppSpan: (_name: string, callback: () => unknown) => callback(),
}));

vi.mock("../branch-candidate-read", () => ({
  getBranchCandidateSnapshots: mocks.getBranchCandidateSnapshots,
}));

vi.mock("../branch-server-analytics-cohort", () => ({
  getBranchServerAnalyticsRows: mocks.getBranchServerAnalyticsRows,
  branchAnalyticsQuerySpanAttributes: mocks.branchAnalyticsQuerySpanAttributes,
}));

vi.mock("./persisted-row-read", () => ({
  getBranchAnalyticsRows: mocks.getBranchAnalyticsRows,
  getBranchRowsById: mocks.getBranchRowsById,
}));

describe("loadBranchAnalyticsRowCohorts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBranchAnalyticsRows.mockImplementation(
      async (_db, _organizationId, branchIds: string[]) =>
        branchIds.map((id) => analyticsRow(id))
    );
    mocks.getBranchCandidateSnapshots.mockResolvedValue([]);
    mocks.branchAnalyticsQuerySpanAttributes.mockReturnValue({});
    mocks.getBranchRowsById.mockImplementation(
      async (_db, _organizationId, branchIds: string[]) =>
        branchIds.map((id) => analyticsRow(id))
    );
  });

  it("hydrates persisted dated analytics rows from one non-date canonical row set", async () => {
    const canonicalCandidates = [
      candidate("branch-a", new Date("2026-07-31T00:00:00.000Z")),
      candidate("branch-b", new Date("2026-08-02T00:00:00.000Z")),
    ];
    mocks.getBranchCandidateSnapshots.mockResolvedValueOnce(
      canonicalCandidates
    );

    const result = await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      query({ startDate: new Date("2026-08-01T00:00:00.000Z") }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledOnce();
    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        startDate: undefined,
        endDate: undefined,
        evaluationNow: new Date("2026-08-20T12:00:00.000Z"),
      })
    );
    expect(mocks.getBranchAnalyticsRows).toHaveBeenCalledOnce();
    expect(mocks.getBranchAnalyticsRows).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      ["branch-a", "branch-b"],
      canonicalCandidates
    );
    expect(result.rows.map((row) => row.id)).toEqual(["branch-b"]);
    expect(result.canonicalRows.map((row) => row.id)).toEqual([
      "branch-a",
      "branch-b",
    ]);
  });

  it("retains null and future activity when filtering date-windowed analytics rows", async () => {
    const canonicalCandidates = [
      candidate("old-activity", new Date("2026-07-31T00:00:00.000Z")),
      candidate("in-window-activity", new Date("2026-08-05T00:00:00.000Z")),
      candidate("unavailable-activity"),
      candidate("future-activity", new Date("2026-08-21T00:00:00.000Z")),
      candidate("after-window-activity", new Date("2026-08-15T00:00:00.000Z")),
      // Exactly ON the end bound: the endDate check is inclusive, so this
      // must be RETAINED, not excluded as "after" the window.
      candidate("end-boundary-activity", new Date("2026-08-10T00:00:00.000Z")),
    ];
    mocks.getBranchCandidateSnapshots.mockResolvedValueOnce(
      canonicalCandidates
    );

    const result = await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      query({
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        endDate: new Date("2026-08-10T00:00:00.000Z"),
      }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(result.rows.map((row) => row.id)).toEqual([
      "in-window-activity",
      "unavailable-activity",
      "future-activity",
      "end-boundary-activity",
    ]);
    expect(result.canonicalRows.map((row) => row.id)).toEqual([
      "old-activity",
      "in-window-activity",
      "unavailable-activity",
      "future-activity",
      "after-window-activity",
      "end-boundary-activity",
    ]);
  });

  it("evaluates the caller-supplied evaluationNow rather than recomputing it from nowIso", async () => {
    const canonicalCandidates = [
      // Occurs strictly after the caller's evaluationNow but before nowIso —
      // only reachable as "future" if the caller's own evaluationNow is the
      // instant actually evaluated, not a value freshly derived from nowIso.
      candidate(
        "future-relative-to-evaluation-now",
        new Date("2026-08-16T00:00:00.000Z")
      ),
    ];
    mocks.getBranchCandidateSnapshots.mockResolvedValueOnce(
      canonicalCandidates
    );

    const result = await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      query({
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        endDate: new Date("2026-08-10T00:00:00.000Z"),
        evaluationNow: new Date("2026-08-15T00:00:00.000Z"),
      }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        evaluationNow: new Date("2026-08-15T00:00:00.000Z"),
      })
    );
    // Past the caller's evaluationNow, so it is retained as "future" rather
    // than being excluded by the endDate bound.
    expect(result.rows.map((row) => row.id)).toEqual([
      "future-relative-to-evaluation-now",
    ]);
  });

  it("filters canonical server rows for direct date-only server analytics", async () => {
    const canonicalCandidates = [
      candidate("branch-a", new Date("2026-07-31T00:00:00.000Z")),
      candidate("branch-b", new Date("2026-08-02T00:00:00.000Z")),
    ];
    mocks.getBranchCandidateSnapshots.mockResolvedValueOnce(
      canonicalCandidates
    );
    mocks.getBranchAnalyticsRows.mockResolvedValueOnce([
      analyticsRow("branch-a"),
      analyticsRow("branch-b"),
    ]);

    const result = await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      query({
        pageMode: BranchListPageMode.Server,
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        endDate: new Date("2026-08-08T00:00:00.000Z"),
      }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledOnce();
    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        startDate: undefined,
        endDate: undefined,
        evaluationNow: new Date("2026-08-20T12:00:00.000Z"),
      })
    );
    expect(mocks.getBranchServerAnalyticsRows).not.toHaveBeenCalled();
    expect(mocks.getBranchAnalyticsRows).toHaveBeenCalledOnce();
    expect(result.rows.map((row) => row.id)).toEqual(["branch-b"]);
    expect(result.canonicalRows.map((row) => row.id)).toEqual([
      "branch-a",
      "branch-b",
    ]);
  });

  it("does not project server analytics rows only to honor a non-default sort", async () => {
    const canonicalCandidates = [
      candidate("branch-a", new Date("2026-07-31T00:00:00.000Z")),
      candidate("branch-b", new Date("2026-08-02T00:00:00.000Z")),
    ];
    mocks.getBranchCandidateSnapshots.mockResolvedValueOnce(
      canonicalCandidates
    );
    mocks.getBranchAnalyticsRows.mockResolvedValueOnce([
      analyticsRow("branch-a"),
      analyticsRow("branch-b"),
    ]);

    const result = await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      query({
        pageMode: BranchListPageMode.Server,
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        endDate: new Date("2026-08-08T00:00:00.000Z"),
      }),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchServerAnalyticsRows).not.toHaveBeenCalled();
    expect(mocks.getBranchAnalyticsRows).toHaveBeenCalledOnce();
    expect(result.rows.map((row) => row.id)).toEqual(["branch-b"]);
    expect(result.canonicalRows.map((row) => row.id)).toEqual([
      "branch-a",
      "branch-b",
    ]);
  });

  it("keeps windowed and canonical populations distinct while loading reusable canonical identity first", async () => {
    seedProjectedServerScope();
    mocks.getBranchServerAnalyticsRows.mockImplementation(
      (_db, _organizationId, operationQuery: BranchListOperationQuery) => {
        if (operationQuery.startDate) {
          return Promise.resolve([analyticsRow("branch-b")]);
        }
        return Promise.resolve([
          analyticsRow("branch-a"),
          analyticsRow("branch-b"),
        ]);
      }
    );

    const result = await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      projectedServerQuery(),
      "2026-08-20T12:00:00.000Z"
    );

    // One date-stripped candidate read feeds both arms.
    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledOnce();
    expect(mocks.getBranchServerAnalyticsRows).toHaveBeenCalledTimes(2);
    expect(mocks.getBranchServerAnalyticsRows).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "org-1",
      expect.objectContaining({
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        names: ["branch-b"],
        evaluationNow: new Date("2026-08-20T12:00:00.000Z"),
      }),
      "2026-08-20T12:00:00.000Z",
      expect.objectContaining({
        // The windowed arm gets the date-stripped cohort narrowed in memory —
        // `branch-a` is older than the window's start.
        candidates: [expect.objectContaining({ id: "branch-b" })],
      })
    );
    expect(mocks.getBranchServerAnalyticsRows).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "org-1",
      expect.objectContaining({
        startDate: undefined,
        endDate: undefined,
        names: ["branch-b"],
        evaluationNow: new Date("2026-08-20T12:00:00.000Z"),
      }),
      "2026-08-20T12:00:00.000Z",
      expect.objectContaining({
        spanPrefix: "branches.analytics.server.canonical",
        candidates: [
          expect.objectContaining({ id: "branch-a" }),
          expect.objectContaining({ id: "branch-b" }),
        ],
      })
    );
    expect(result.rows.map((row) => row.id)).toEqual(["branch-b"]);
    expect(result.canonicalRows.map((row) => row.id)).toEqual([
      "branch-a",
      "branch-b",
    ]);
  });

  /**
   * ISS-9111: the two date arms of this path used to each run their own
   * corpus-wide candidate scan and their own corpus-wide list-row hydration.
   * The windowed arm's candidate set is the date-stripped one narrowed by the
   * same predicate the SQL applies, and its rows are those rows, so both are
   * read ONCE and handed to both arms.
   *
   * The counts below are literals for what one request may issue, not a
   * re-derivation of what the code does: each was 2 before this change, and each
   * is 1 for a corpus of any size.
   */
  it("reads the candidate scope and the list rows once for both date arms", async () => {
    seedProjectedServerScope();
    mocks.getBranchServerAnalyticsRows.mockResolvedValue([]);

    await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      projectedServerQuery(),
      "2026-08-20T12:00:00.000Z"
    );

    // The hoisted scan is the same logical span the per-arm scan was, so it must
    // still describe the request shape it ran for.
    expect(mocks.branchAnalyticsQuerySpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        names: ["branch-b"],
      })
    );
    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ startDate: undefined, endDate: undefined })
    );
    expect(mocks.getBranchRowsById).toHaveBeenCalledTimes(1);
    expect(mocks.getBranchRowsById).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      ["branch-a", "branch-b"],
      expect.anything()
    );
    // Neither arm re-reads: each was handed the rows this call already holds.
    for (const call of mocks.getBranchServerAnalyticsRows.mock.calls) {
      expect(call[4]?.listRows?.map((row: { id: string }) => row.id)).toEqual([
        "branch-a",
        "branch-b",
      ]);
    }
  });

  it("reuses the initial row set for unbounded analytics", async () => {
    const candidates = [candidate("branch-a"), candidate("branch-b")];
    mocks.getBranchCandidateSnapshots.mockResolvedValueOnce(candidates);

    const result = await loadBranchAnalyticsRowCohorts(
      db(),
      "org-1",
      query(),
      "2026-08-20T12:00:00.000Z"
    );

    expect(mocks.getBranchCandidateSnapshots).toHaveBeenCalledOnce();
    expect(mocks.getBranchAnalyticsRows).toHaveBeenCalledOnce();
    expect(result.canonicalRows).toBe(result.rows);
  });
});

/** A server-page query with a date window AND a projection facet, the state that
 * forces the two-arm read this file resolves. */
function projectedServerQuery(): BranchListOperationQuery {
  return query({
    pageMode: BranchListPageMode.Server,
    startDate: new Date("2026-08-01T00:00:00.000Z"),
    names: ["branch-b"],
  });
}

/** One branch outside the window and one inside it, plus their list rows. */
function seedProjectedServerScope() {
  mocks.getBranchCandidateSnapshots.mockResolvedValue([
    candidate("branch-a", new Date("2026-07-31T00:00:00.000Z")),
    candidate("branch-b", new Date("2026-08-02T00:00:00.000Z")),
  ]);
}

function db(): Parameters<typeof loadBranchAnalyticsRowCohorts>[0] {
  return {} as Parameters<typeof loadBranchAnalyticsRowCohorts>[0];
}

function query(
  overrides: Partial<BranchListOperationQuery> = {}
): BranchListOperationQuery {
  return {
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

function candidate(id: string, occurredAt: Date | null = null) {
  return {
    id,
    repositorySortKey: "closedloop-ai/closedloop-ai",
    branchSortKey: id,
    activityAtom: occurredAt
      ? {
          version: BranchActivityAtomVersion.V1,
          source: BranchActivitySource.GitHead,
          sourceEventId: `event-${id}`,
          occurredAt,
          activityKind: null,
          attributionKind: BranchActivityAttributionKind.Branch,
          pullRequestDetailId: null,
          completeness: BranchActivityEvidenceCompleteness.Complete,
          createdAt: occurredAt,
        }
      : null,
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
