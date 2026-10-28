import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import { DEFAULT_BRANCH_STATUS_ORDERING } from "@repo/api/src/types/branch-status-order";
import { describe, expect, it, vi } from "vitest";
import {
  BranchListEnrichmentRead,
  createBranchListEnrichmentDomain,
} from "../branch-list-enrichment";
import {
  decodeBranchServerPageRows,
  readBranchServerPageFromSql,
} from "./branch-server-page-read";
import {
  BranchListSqlAvailabilityMeasure,
  type BranchListSqlRow,
  BranchListSqlRowKind,
} from "./branch-server-page-sql";

vi.mock("@/lib/db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db-utils")>();
  return { ...actual, getPrismaErrorCode: vi.fn(actual.getPrismaErrorCode) };
});

vi.mock("../branch-list-enrichment", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../branch-list-enrichment")>();
  return {
    ...actual,
    markBranchListEnrichmentUnavailable: vi.fn(),
  };
});

describe("readBranchServerPageFromSql", () => {
  it("marks identity unavailable and rethrows a non-P2028 failure while identity is resolved", async () => {
    const { markBranchListEnrichmentUnavailable } = await import(
      "../branch-list-enrichment"
    );
    const error = new Error("connection reset");
    const db = { $queryRaw: vi.fn().mockRejectedValue(error) };
    const enrichment = createBranchListEnrichmentDomain();

    await expect(
      readBranchServerPageFromSql(
        db,
        "org-1",
        { limit: 20, offset: 0 },
        serverPageQuery(),
        new Date("2026-08-20T00:00:00.000Z"),
        DEFAULT_BRANCH_STATUS_ORDERING,
        enrichment
      )
    ).rejects.toThrow("connection reset");

    expect(markBranchListEnrichmentUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        read: BranchListEnrichmentRead.Identity,
        context: { organizationId: "org-1" },
        error,
      })
    );
  });

  it("rethrows without marking identity unavailable when identity was already skipped", async () => {
    const { markBranchListEnrichmentUnavailable } = await import(
      "../branch-list-enrichment"
    );
    vi.mocked(markBranchListEnrichmentUnavailable).mockClear();
    const error = new Error("connection reset");
    const db = { $queryRaw: vi.fn().mockRejectedValue(error) };
    const enrichment = createBranchListEnrichmentDomain([
      BranchListEnrichmentRead.Identity,
    ]);

    await expect(
      readBranchServerPageFromSql(
        db,
        "org-1",
        { limit: 20, offset: 0 },
        serverPageQuery(),
        new Date("2026-08-20T00:00:00.000Z"),
        DEFAULT_BRANCH_STATUS_ORDERING,
        enrichment
      )
    ).rejects.toThrow("connection reset");

    expect(markBranchListEnrichmentUnavailable).not.toHaveBeenCalled();
  });

  it("rethrows a P2028 snapshot-expiry failure without marking identity unavailable", async () => {
    const { markBranchListEnrichmentUnavailable } = await import(
      "../branch-list-enrichment"
    );
    vi.mocked(markBranchListEnrichmentUnavailable).mockClear();
    const error = Object.assign(new Error("snapshot expired"), {
      code: "P2028",
    });
    const db = { $queryRaw: vi.fn().mockRejectedValue(error) };
    const enrichment = createBranchListEnrichmentDomain();

    await expect(
      readBranchServerPageFromSql(
        db,
        "org-1",
        { limit: 20, offset: 0 },
        serverPageQuery(),
        new Date("2026-08-20T00:00:00.000Z"),
        DEFAULT_BRANCH_STATUS_ORDERING,
        enrichment
      )
    ).rejects.toThrow("snapshot expired");

    expect(markBranchListEnrichmentUnavailable).not.toHaveBeenCalled();
  });
});

describe("decodeBranchServerPageRows", () => {
  it("orders the page by ord, floors a null ord to the front, and drops a null-value page row", () => {
    const rows: BranchListSqlRow[] = [
      pageRow("branch-a", 2),
      pageRow(null, 1),
      pageRow("branch-b", null),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.pageIds).toEqual(["branch-b", "branch-a"]);
  });

  it("keeps two null-ord page rows in a stable relative order", () => {
    const rows: BranchListSqlRow[] = [
      pageRow("branch-first", null),
      pageRow("branch-second", null),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    // Both floor to rank 0, so the comparator must report them equal rather
    // than reordering — proves the `??` fallback fires on BOTH sides of the
    // single comparison V8 makes for a two-element array.
    expect(result.pageIds).toEqual(["branch-first", "branch-second"]);
  });

  it("reads total/offset/retained scalars and defaults an absent scalar to zero", () => {
    const rows: BranchListSqlRow[] = [
      scalarRow(BranchListSqlRowKind.Total, 7),
      scalarRow(BranchListSqlRowKind.Offset, 3),
      // No Retained row supplied — must default to 0, not throw or omit the key.
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.total).toBe(7);
    expect(result.repairedOffset).toBe(3);
    expect(result.retainedUnavailableCount).toBe(0);
  });

  it("falls back to the raw value as a facet option's label when no label was aggregated", () => {
    const rows: BranchListSqlRow[] = [
      facetRow("names", "alice", "Alice", 3),
      facetRow("names", "bob", null, null),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.facets.names.options).toEqual([
      { id: "alice", label: "Alice", count: 3 },
      { id: "bob", label: "bob", count: 0 },
    ]);
  });

  it("excludes a null-valued row and a different-facet row from a facet's options", () => {
    const rows: BranchListSqlRow[] = [
      facetRow("names", "alice", "Alice", 3),
      // Same facet, but no value: must not become an option (and must not
      // report a fabricated id/label of "").
      { ...facetRow("names", "", null, 5), value: null },
      // A real value, but the WRONG facet: must not leak into "names".
      facetRow("owners", "someone", "Someone", 9),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.facets.names.options).toEqual([
      { id: "alice", label: "Alice", count: 3 },
    ]);
  });

  it("breaks a facet-option label tie by id so equal-label options sort deterministically", () => {
    const rows: BranchListSqlRow[] = [
      facetRow("names", "b-id", "Same Label", 1),
      facetRow("names", "a-id", "Same Label", 2),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.facets.names.options.map((option) => option.id)).toEqual([
      "a-id",
      "b-id",
    ]);
  });

  it("folds the owners availability tallies into an Incomplete facet state", () => {
    const rows: BranchListSqlRow[] = [
      availabilityRow("owners", BranchListSqlAvailabilityMeasure.Rows, 5),
      availabilityRow(
        "owners",
        BranchListSqlAvailabilityMeasure.NonComplete,
        2
      ),
      availabilityRow(
        "owners",
        BranchListSqlAvailabilityMeasure.Unavailable,
        0
      ),
      // A row of a different kind (not Availability) must not be mistaken for
      // an availability tally.
      facetRow("owners", "someone", "Someone", 1),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.facets.owners.availability).toBe(
      BranchListFacetAvailability.Incomplete
    );
  });

  it("does not mistake a same-named Facet-kind row for an Availability tally", () => {
    const rows: BranchListSqlRow[] = [
      // Coincidentally uses the "rows"/"unavailable" measure names as its
      // facet VALUE, but is kind=Facet, not kind=Availability. If the kind
      // check were dropped, this pair alone would fold "collaborators" to
      // Unavailable even though no real availability row exists for it.
      facetRow("collaborators", BranchListSqlAvailabilityMeasure.Rows, null, 3),
      facetRow(
        "collaborators",
        BranchListSqlAvailabilityMeasure.Unavailable,
        null,
        3
      ),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.facets.collaborators.availability).toBe(
      BranchListFacetAvailability.Complete
    );
  });

  it("ignores an availability row with no facet name", () => {
    const rows: BranchListSqlRow[] = [
      {
        kind: BranchListSqlRowKind.Availability,
        facet: null,
        value: BranchListSqlAvailabilityMeasure.Rows,
        label: null,
        count: 9,
        ord: null,
      },
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    // With no tallies recorded at all, the fold treats the facet as an empty,
    // fully-known population.
    expect(result.facets.owners.availability).toBe(
      BranchListFacetAvailability.Complete
    );
  });

  it("treats a null availability tally count as zero rather than dropping the measure", () => {
    const rows: BranchListSqlRow[] = [
      {
        kind: BranchListSqlRowKind.Availability,
        facet: "owners",
        value: BranchListSqlAvailabilityMeasure.Rows,
        label: null,
        count: null,
        ord: null,
      },
      availabilityRow(
        "owners",
        BranchListSqlAvailabilityMeasure.Unavailable,
        0
      ),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    // A zero-row population (the null tally folded to 0, not skipped) is
    // reported Complete rather than Unavailable or Incomplete.
    expect(result.facets.owners.availability).toBe(
      BranchListFacetAvailability.Complete
    );
  });

  it("labels a repository option with its short display name", () => {
    const rows: BranchListSqlRow[] = [
      facetRow(
        "repositories",
        "closedloop-ai/closedloop-ai",
        "closedloop-ai/closedloop-ai",
        4
      ),
    ];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.facets.repositories.options).toEqual([
      {
        id: "closedloop-ai/closedloop-ai",
        label: "closedloop-ai",
        count: 4,
      },
    ]);
  });

  it("reports every fixed status option even when the corpus never produced a row for it", () => {
    const rows: BranchListSqlRow[] = [];

    const result = decodeBranchServerPageRows(
      rows,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(result.facets.statuses.options.map((option) => option.id)).toEqual(
      DEFAULT_BRANCH_STATUS_ORDERING.order
    );
    expect(
      result.facets.statuses.options.every((option) => option.count === 0)
    ).toBe(true);
  });
});

function serverPageQuery(): BranchServerPageQuery {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
  };
}

function pageRow(value: string | null, ord: number | null): BranchListSqlRow {
  return {
    kind: BranchListSqlRowKind.Page,
    facet: null,
    value,
    label: null,
    count: null,
    ord,
  };
}

function scalarRow(
  kind: BranchListSqlRowKind,
  count: number
): BranchListSqlRow {
  return { kind, facet: null, value: null, label: null, count, ord: null };
}

function facetRow(
  facet: string,
  value: string,
  label: string | null,
  count: number | null
): BranchListSqlRow {
  return {
    kind: BranchListSqlRowKind.Facet,
    facet,
    value,
    label,
    count,
    ord: null,
  };
}

function availabilityRow(
  facet: string,
  measure: BranchListSqlAvailabilityMeasure,
  count: number
): BranchListSqlRow {
  return {
    kind: BranchListSqlRowKind.Availability,
    facet,
    value: measure,
    label: null,
    count,
    ord: null,
  };
}
