import { BranchListSqlRowKind } from "@/app/branches/branch-list-sql/branch-server-page-sql";

/**
 * ISS-10298 — the Branches server-page read resolves its ids, totals and facets
 * in ONE statement before anything is hydrated. This stands in for that
 * statement by reading the candidate response the calling test already queued,
 * so a test that declares its corpus once still declares it once: the page
 * statement reads the ids, and `getBranchCandidateSnapshots` still shifts the
 * same entry for the hydration that follows.
 *
 * It deliberately returns NO facet rows. Facet counts are derived by the SQL
 * this stands in for, so a synthesized option list would be an assertion about
 * the fixture rather than about the producer — that coverage lives in
 * `__tests__/integration/branch-list-sql-parity.integration.test.ts`, against a
 * real database.
 */
export function branchServerPageMockRows(
  queuedCandidateRows: readonly unknown[] | undefined
): BranchServerPageMockRow[] {
  const queued = (queuedCandidateRows ?? []) as CandidateSnapshotRow[];
  const ids = queued.flatMap((row) =>
    typeof row.id === "string" ? [row.id] : []
  );
  const total = Number(queued[0]?.count ?? ids.length);
  return [
    ...ids.map((id, index) =>
      scalarRow(BranchListSqlRowKind.Page, id, null, index + 1)
    ),
    scalarRow(BranchListSqlRowKind.Total, null, total, null),
    scalarRow(BranchListSqlRowKind.Retained, null, 0, null),
    scalarRow(BranchListSqlRowKind.Offset, null, 0, null),
  ];
}

function scalarRow(
  kind: BranchListSqlRowKind,
  value: string | null,
  count: number | null,
  ord: number | null
): BranchServerPageMockRow {
  return { kind, facet: null, value, label: null, count, ord };
}

type BranchServerPageMockRow = {
  kind: BranchListSqlRowKind;
  facet: string | null;
  value: string | null;
  label: string | null;
  count: number | null;
  ord: number | null;
};

/** The columns {@link branchServerPageMockRows} reads off a queued row. */
type CandidateSnapshotRow = {
  id?: unknown;
  count?: unknown;
};
