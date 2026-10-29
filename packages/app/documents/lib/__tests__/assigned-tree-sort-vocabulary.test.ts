/**
 * ISS-12636: the server's root-sort vocabulary and comparator agree with the
 * board's.
 *
 * The query that orders roots in SQL is a mirror of `ITEM_SORT_CONFIGS`, and
 * `apps/api` cannot import this package to check that — so the pin lives here,
 * on the side that owns the original. Two things are held:
 *
 *  1. Every spelling the route accepts is a column the board actually asks for.
 *     A server key the client never sends is a dead parameter; a client key
 *     spelled differently is a silent 400 on a column that looks supported.
 *  2. For each shared column, `compareAssignedTreeSortValues` orders rows the
 *     way that column's own comparator does. Without this the SQL could be a
 *     faithful mirror of a comparator nothing renders.
 *
 * `status` and `priority` are deliberately absent from the server vocabulary
 * and so are absent here; `stackRank` has no comparator on either side, being
 * the order the query already returns.
 */

import {
  ASSIGNED_TREE_SORT_KEYS,
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
  type AssignedTreeSortValues,
  compareAssignedTreeSortValues,
} from "@repo/api/src/types/assigned-tree-sort";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { SORT_KEYS } from "@repo/app/documents/components/table/sort-keys";
import { DEFAULT_TABLE_VIEW_ORDERING } from "@repo/app/documents/lib/table-view-pipeline";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

type Assignee = {
  firstName: string | null;
  lastName: string | null;
  email: string;
};

const ZOE: Assignee = {
  email: "zoe@example.com",
  firstName: "Zoe",
  lastName: "Adams",
};
/** No name parts, so the display name folds to the email. */
const EMAIL_ONLY: Assignee = {
  email: "aaron@example.com",
  firstName: null,
  lastName: null,
};

type Row = {
  id: string;
  title: string;
  type: DocumentType;
  slug: string;
  updatedAt: Date;
  assignee: Assignee | null;
};

/**
 * Adversarial on the axes where the two mirrors could part: case folding, an
 * accent, a leading punctuation mark, a digit run read as a magnitude, and an
 * absent value on each nullable column.
 */
const ROWS: readonly Row[] = [
  {
    assignee: ZOE,
    id: "r1",
    slug: "ISS-9",
    title: "apple",
    type: DocumentType.Prd,
    updatedAt: new Date("2026-07-01T00:00:00Z"),
  },
  {
    assignee: null,
    id: "r2",
    slug: "ISS-10",
    title: "Apple",
    type: DocumentType.Feature,
    updatedAt: new Date("2026-05-01T00:00:00Z"),
  },
  {
    assignee: EMAIL_ONLY,
    id: "r3",
    slug: "ISS-100",
    title: "Äpple",
    type: DocumentType.ImplementationPlan,
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  },
  {
    assignee: ZOE,
    id: "r4",
    slug: "PRD-2",
    title: "_leading",
    type: DocumentType.Template,
    updatedAt: new Date("2026-07-01T00:00:00Z"),
  },
  {
    assignee: null,
    // The empty slug the row adapter writes for an unslugged artifact.
    id: "r5",
    slug: "",
    title: "10th",
    type: DocumentType.Doc,
    updatedAt: new Date("2026-05-01T00:00:00Z"),
  },
];

function rowItem(row: Row): DocumentRowItem {
  return {
    data: {
      ...createMockDocument({
        id: row.id,
        slug: row.slug,
        title: row.title,
        type: row.type,
      }),
      assignee: row.assignee === null ? null : { ...row.assignee, id: row.id },
      assigneeId: row.assignee === null ? null : row.id,
      updatedAt: row.updatedAt,
    } as DocumentWithProject,
    kind: "document",
  };
}

function sortValues(row: Row): AssignedTreeSortValues {
  return {
    assigneeDisplayName:
      row.assignee === null ? null : getUserDisplayName(row.assignee),
    slug: row.slug,
    title: row.title,
    type: row.type,
    updatedAt: row.updatedAt,
  };
}

const EVERY_DIRECTION = Object.values(AssignedTreeSortDirection);

describe("assigned-tree sort vocabulary (ISS-12636)", () => {
  it("runs on a host whose collation the board's comparators can match", () => {
    // The board's comparators call `localeCompare` with NO locale, so they rank
    // by the HOST's collation, while the server mirror pins "en"
    // (`LIST_QUERY_COLLATED_LOCALE`). The parity case below therefore compares
    // a host-dependent order against a pinned one, and its fixture is chosen
    // on exactly the axis where locales part. Asserting the dependency here
    // means a runner that would silently break the comparison fails with this
    // sentence instead of with an opaque ordering diff.
    //
    // This is also the live consequence of moving the sort server-side: a
    // viewer on a non-en locale gets a server order their browser would not
    // have produced. That is the ticket's own trade, recorded here rather than
    // hidden.
    const hostRanksAccentAfterA =
      "Äpple".localeCompare("apple") > 0 && "Äpple".localeCompare("banana") < 0;

    expect(hostRanksAccentAfterA).toBe(true);
  });

  it("names only columns the board itself sorts by", () => {
    const clientKeys = new Set<string>(SORT_KEYS);

    for (const key of ASSIGNED_TREE_SORT_KEYS) {
      expect(clientKeys).toContain(key);
    }
  });

  it("leaves the board's remaining columns to the client", () => {
    // Not a wish list: each absence is a decision. `stackRank` is the order the
    // query already returns, and `status`/`priority` wait on which of the
    // ISS-9437 orderings the server should reproduce. Pinned so adding a server
    // key without removing it from this list fails rather than passing quietly.
    const serverKeys = new Set<string>(ASSIGNED_TREE_SORT_KEYS);
    const clientOnly = SORT_KEYS.filter((key) => !serverKeys.has(key));

    expect([...clientOnly].sort()).toEqual(
      ["priority", "stackRank", "status"].sort()
    );
  });

  it("has a board comparator for every column it claims", () => {
    for (const key of ASSIGNED_TREE_SORT_KEYS) {
      const config = DEFAULT_TABLE_VIEW_ORDERING.itemSortConfigs[key];

      expect(config?.comparator ?? config?.directedComparator).toBeDefined();
    }
  });

  it("orders each shared column exactly as the board's own comparator does", () => {
    for (const key of ASSIGNED_TREE_SORT_KEYS) {
      const config = DEFAULT_TABLE_VIEW_ORDERING.itemSortConfigs[key];
      const comparator = config?.comparator;
      if (!comparator) {
        throw new Error(`no board comparator for ${key}`);
      }

      for (const direction of EVERY_DIRECTION) {
        // `buildSortedGroups` negates a `comparator` wholesale for a descending
        // sort, which is what the server comparator reproduces — including for
        // an absent value, which therefore moves to the TOP descending.
        const sign = direction === AssignedTreeSortDirection.Asc ? 1 : -1;
        const board = [...ROWS]
          .sort(
            (left, right) => comparator(rowItem(left), rowItem(right)) * sign
          )
          .map((row) => row.id);
        const server = [...ROWS]
          .sort((left, right) =>
            compareAssignedTreeSortValues(sortValues(left), sortValues(right), {
              direction,
              key,
            })
          )
          .map((row) => row.id);

        expect({ direction, key, order: server }).toEqual({
          direction,
          key,
          order: board,
        });
      }
    }
  });

  it("agrees that a slug's digit run is a magnitude", () => {
    // Asserted on the board side too: an equality between two mirrors cannot
    // tell agreement from a shared mistake, and code-unit order would put
    // ISS-10 and ISS-100 ahead of ISS-9 on both.
    const comparator =
      DEFAULT_TABLE_VIEW_ORDERING.itemSortConfigs[AssignedTreeSortKey.Slug]
        ?.comparator;
    if (!comparator) {
      throw new Error("no board comparator for slug");
    }
    const board = [...ROWS]
      .sort((left, right) => comparator(rowItem(left), rowItem(right)))
      .map((row) => row.slug)
      .filter(Boolean);

    expect(board).toEqual(["ISS-9", "ISS-10", "ISS-100", "PRD-2"]);
  });
});
