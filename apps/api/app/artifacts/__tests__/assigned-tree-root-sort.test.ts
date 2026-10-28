/**
 * ISS-12636: the shape of the root `ORDER BY` the query emits.
 *
 * Asserted on the EXPRESSION rather than on a returned fixture because that is
 * the only thing a fixture cannot establish. A page of rows that happens to
 * come back in the right order proves the plan produced it, not that the
 * statement asked for it: `assigned-tree-stack-rank-parity` measured exactly
 * that — deleting the `id` tiebreak left every row-order assertion green,
 * because the plan it chose returned id order anyway. The ordering's real
 * behaviour against Postgres is `assigned-tree-root-sort-parity`'s job; this
 * suite holds the terms.
 */

import {
  ArtifactSubtypeInput,
  normalizeArtifactSubtype,
} from "@repo/api/src/types/artifact";
import {
  ASSIGNED_TREE_SORT_KEYS,
  ASSIGNED_TREE_SORT_TEXT_ORDERING,
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
} from "@repo/api/src/types/assigned-tree-sort";
import {
  LIST_QUERY_TEXT_COLLATION,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
import { ArtifactSubtype } from "@repo/database";
import { describe, expect, it } from "vitest";
import { STACK_RANK_ORDER_BY_SQL } from "../artifact-tree-shared";
import {
  assignedTreeRootOrderBySql,
  assignedTreeRootSortJoinSql,
} from "../assigned-tree-root-sort";

/**
 * The statement text WITH its bound values substituted in, left to right.
 *
 * `Prisma.Sql.sql` renders every bind as a bare `?`, so the subtype and
 * document-type literals of the Type column's `CASE` are invisible in it — the
 * text alone reads `WHEN ? THEN ?` five times and would pass against a mapping
 * whose arms were all the same. Walking `values` in order is what makes an
 * assertion about the mapping possible at all.
 *
 * Positional and deliberately so: the arms are built by `Prisma.join`, which
 * appends its values in arm order, so the Nth `?` is the Nth value.
 */
function rendered(sql: { sql: string; values: readonly unknown[] }): string {
  const parts = sql.sql.split("?");
  return parts.reduce(
    (text, part, index) =>
      index === 0 ? part : `${text}${String(sql.values[index - 1])}${part}`,
    ""
  );
}

/** The sorted column's own term, ending in the direction and nothing else. */
const TITLE_DESCENDING = /^normalize\(a\.name, NFC\) COLLATE "[^"]+" DESC,$/;

const EVERY_DIRECTION = Object.values(AssignedTreeSortDirection);

describe("assignedTreeRootOrderBySql (ISS-12636)", () => {
  it("falls back to stack rank when no column was requested", () => {
    expect(assignedTreeRootOrderBySql(undefined).sql).toBe(
      STACK_RANK_ORDER_BY_SQL.sql
    );
  });

  it("ends EVERY column, in BOTH directions, with the stack-rank terms", () => {
    // The mirror of a stable client sort over a stack-rank-ordered input. It is
    // asserted over the whole vocabulary rather than per column so a key added
    // later cannot ship without it — and without it a tied pair orders
    // differently on two reads, which a PAGED result then slices, serving one
    // root twice and skipping another.
    for (const key of ASSIGNED_TREE_SORT_KEYS) {
      for (const direction of EVERY_DIRECTION) {
        const text = assignedTreeRootOrderBySql({ direction, key }).sql;

        expect(text.endsWith(STACK_RANK_ORDER_BY_SQL.sql)).toBe(true);
      }
    }
  });

  it("applies the direction to the COLUMN and never to the tiebreak", () => {
    const descending = assignedTreeRootOrderBySql({
      direction: AssignedTreeSortDirection.Desc,
      key: AssignedTreeSortKey.Title,
    }).sql;

    expect(descending).toContain("a.name");
    // Everything ahead of the stack-rank block is the column's own term, and
    // the direction must be the last thing in it. Taken as a slice rather than
    // searched for, because the key expression now carries a comma of its own
    // (`normalize(…, NFC)`) and a pattern loose enough to cross it would also
    // admit a `DESC` sitting on a later term.
    const columnTerm = descending.slice(
      0,
      descending.length - STACK_RANK_ORDER_BY_SQL.sql.length
    );
    expect(columnTerm.trimEnd()).toMatch(TITLE_DESCENDING);
    // A tiebreak that flipped with the direction is not a tiebreak: the two
    // directions would disagree about which of two equal rows comes first.
    expect(descending).toContain("a.sort_order ASC NULLS LAST");
    expect(descending).toContain("a.id ASC");
  });

  it("collates each text column with the class the contract declares", () => {
    for (const [key, ordering] of Object.entries(
      ASSIGNED_TREE_SORT_TEXT_ORDERING
    )) {
      const text = assignedTreeRootOrderBySql({
        direction: AssignedTreeSortDirection.Asc,
        key: key as AssignedTreeSortKey,
      }).sql;

      expect(text).toContain(
        `COLLATE "${LIST_QUERY_TEXT_COLLATION[ordering]}"`
      );
    }
  });

  it("ranks the slug NATURALLY, so ISS-9 precedes ISS-10", () => {
    // Pinned as its own case because it is the one class the shared ruling did
    // not already carry, and because `CodeUnit` — which that ruling names for a
    // slug — reverses the pair the board shows today.
    expect(ASSIGNED_TREE_SORT_TEXT_ORDERING[AssignedTreeSortKey.Slug]).toBe(
      ListQueryTextOrdering.Natural
    );
    expect(
      assignedTreeRootOrderBySql({
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Slug,
      }).sql
    ).toContain(
      `COLLATE "${LIST_QUERY_TEXT_COLLATION[ListQueryTextOrdering.Natural]}"`
    );
  });

  it("folds an EMPTY slug to NULL rather than sorting it as the smallest string", () => {
    expect(
      assignedTreeRootOrderBySql({
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Slug,
      }).sql
    ).toContain("NULLIF(a.slug, '')");
  });

  it("orders the Updated column on the instant, with no collation", () => {
    const text = assignedTreeRootOrderBySql({
      direction: AssignedTreeSortDirection.Asc,
      key: AssignedTreeSortKey.Updated,
    }).sql;

    expect(text).toContain("a.updated_at ASC");
    expect(text).not.toContain("COLLATE");
  });

  it("maps EVERY subtype the column can hold to its document type", () => {
    // The board sorts Type on the MAPPED value, so an arm missing here orders a
    // whole subtype by the wrong string. Rendered with its binds substituted:
    // the arms are a `Prisma.join`, and the raw text shows only placeholders.
    //
    // Expected values come from `normalizeArtifactSubtype`, the owner of the
    // fold, rather than from a table written out here — a second table would
    // agree with the query's own mistake.
    const text = rendered(
      assignedTreeRootOrderBySql({
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Type,
      })
    );

    const spellings = Object.values(ArtifactSubtypeInput);
    expect(spellings).toHaveLength(Object.keys(ArtifactSubtype).length);
    for (const subtype of spellings) {
      expect(text).toContain(
        `WHEN ${subtype} THEN ${normalizeArtifactSubtype(subtype)}`
      );
    }
  });

  it("reads the artifact type for a row that is not a document", () => {
    const text = assignedTreeRootOrderBySql({
      direction: AssignedTreeSortDirection.Asc,
      key: AssignedTreeSortKey.Type,
    }).sql;

    expect(text).toContain("ELSE a.type::text");
  });
});

describe("assignedTreeRootSortJoinSql (ISS-12636)", () => {
  it("joins users ONLY for the assignee column", () => {
    for (const key of ASSIGNED_TREE_SORT_KEYS) {
      const text = assignedTreeRootSortJoinSql({
        direction: AssignedTreeSortDirection.Asc,
        key,
      }).sql;

      if (key === AssignedTreeSortKey.Assignee) {
        expect(text).toContain("LEFT JOIN users assignee");
        continue;
      }
      expect(text).toBe("");
    }
  });

  it("joins nothing when no column was requested", () => {
    expect(assignedTreeRootSortJoinSql(undefined).sql).toBe("");
  });
});
