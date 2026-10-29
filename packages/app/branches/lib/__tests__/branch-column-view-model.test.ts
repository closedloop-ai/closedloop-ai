import { BranchListSortKey } from "@repo/api/src/types/branch-list-contract";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import {
  admitFilterableGroups,
  groupableColumnOptions,
  sortableColumnOptions,
} from "../../../shared/lib/column-view-model";
import {
  BRANCH_COLUMN_VIEW_MODEL,
  branchSortKeyForColumn,
  branchSortRules,
  groupBranchRows,
  groupUniversalBranchRows,
  resolveBranchSortColumnId,
} from "../branch-column-view-model";
import { BranchRowStatus } from "../branch-row";
import { branchRow } from "./branch-row-fixture";

/**
 * ISS-9676 — the Branches column view model, pinned against literals written
 * out here rather than derived from the declaration under test.
 *
 * The duplication IS the test: deriving the expected ids from
 * `BRANCH_COLUMN_VIEW_MODEL` would make every assertion agree with whatever the
 * declaration currently says, including a column that silently lost a
 * capability.
 */

const SORTABLE_COLUMN_IDS = [
  "name",
  "owner",
  "sessions",
  "changes",
  "status",
  "pr",
  "lastActivity",
  "repo",
  // ISS-10332 (PLN-2086 Milestone 2): the producer's `priority` ordering,
  // offered once the column landed.
  "priority",
];

/** The nine approved facets plus ISS-10332's priority facet, spelled out. */
const FILTERABLE_FACET_IDS = [
  "name",
  "owner",
  "collaborators",
  "changes",
  "status",
  "pullRequest",
  "lastActive",
  "repository",
  "tags",
  "priority",
];

/** The operator's grouping vocabulary (2026-09-07), verbatim. */
const GROUP_OPTIONS = [
  { id: "owner", label: "Author" },
  { id: "status", label: "PR / review state" },
  { id: "repo", label: "Repository" },
];

function grouping(
  primaryFieldId: string | null,
  order: TableGroupOrder = TableGroupOrder.Custom,
  secondaryFieldId: string | null = null
): TableGroupingState {
  return {
    primary: { fieldId: primaryFieldId, order, showEmptyGroups: false },
    secondary: {
      fieldId: secondaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
  };
}

describe("the declared capabilities", () => {
  it("offers exactly the nine sortable columns", () => {
    expect(
      sortableColumnOptions(BRANCH_COLUMN_VIEW_MODEL).map((option) => option.id)
    ).toEqual(SORTABLE_COLUMN_IDS);
  });

  // Collaborators and Tags are the counterfactual: both are real columns with
  // real facets, and neither has an ordering, so a view model that simply
  // declared every column sortable would fail here.
  it("withholds sorting from the columns that have no ordering", () => {
    const sortable = new Set(
      sortableColumnOptions(BRANCH_COLUMN_VIEW_MODEL).map((option) => option.id)
    );

    expect(sortable.has("collaborators")).toBe(false);
    expect(sortable.has("tags")).toBe(false);
  });

  it("admits exactly the ten declared filter facets", () => {
    const declared = BRANCH_COLUMN_VIEW_MODEL.flatMap((column) =>
      column.isFilterable ? [column.filterFacetId] : []
    );

    expect(declared).toEqual(FILTERABLE_FACET_IDS);
  });

  // Linked sessions is the mirror counterfactual: sortable, and deliberately
  // not filterable, so the two flags cannot be one flag wearing two names.
  it("withholds filtering from Linked sessions while keeping it sortable", () => {
    const sessions = BRANCH_COLUMN_VIEW_MODEL.find(
      (column) => column.id === "sessions"
    );

    expect(sessions?.isSortable).toBe(true);
    expect(sessions?.isFilterable).toBe(false);
  });

  // The Branches toolbar runs its facet list through `admitFilterableGroups`.
  // Today that call removes nothing — the ten declared facets ARE the declared
  // set — so this is where its causality lives: the rule is the guard that
  // catches an eleventh facet arriving without a column to justify it.
  it("admits the ten declared facets and refuses one no column declares", () => {
    const offered = [
      ...FILTERABLE_FACET_IDS.map((id) => ({ id })),
      { id: "sessions" },
    ];

    expect(
      admitFilterableGroups(BRANCH_COLUMN_VIEW_MODEL, offered).map(
        (group) => group.id
      )
    ).toEqual(FILTERABLE_FACET_IDS);
  });

  it("groups by the operator's three dimensions and nothing else", () => {
    expect(groupableColumnOptions(BRANCH_COLUMN_VIEW_MODEL)).toEqual(
      GROUP_OPTIONS
    );
  });

  it("maps every wire sort key to a column and back", () => {
    for (const sortKey of Object.values(BranchListSortKey)) {
      const columnId = resolveBranchSortColumnId(sortKey);

      expect(columnId, sortKey).not.toBeNull();
      expect(branchSortKeyForColumn(columnId as string)).toBe(sortKey);
    }
  });

  it("refuses a column this build does not order by", () => {
    expect(branchSortKeyForColumn("collaborators")).toBeNull();
    expect(branchSortKeyForColumn("constructor")).toBeNull();
    expect(resolveBranchSortColumnId("__proto__")).toBeNull();
  });
});

describe("branchSortRules", () => {
  it("reports the persisted ordering as the menu's single rule", () => {
    expect(branchSortRules(BranchListSortKey.Status, "asc")).toEqual([
      { direction: "asc", fieldId: "status" },
    ]);
  });

  it("reports nothing for a sort key this build no longer offers", () => {
    expect(branchSortRules("retired-key", "desc")).toEqual([]);
  });
});

describe("groupBranchRows", () => {
  const ROWS = [
    branchRow({ id: "a", owner: "Alex", repo: "acme/web" }),
    branchRow({
      id: "b",
      owner: "Blake",
      repo: "acme/api",
      status: BranchRowStatus.Merged,
    }),
    branchRow({ id: "c", owner: "Alex", repo: "acme/api" }),
  ];

  it("partitions by Author", () => {
    const bands = groupBranchRows(ROWS, grouping("owner"), ROWS);

    expect(bands.map((band) => band.label)).toEqual(["Alex", "Blake"]);
    expect(bands[0]?.items.map((row) => row.id)).toEqual(["a", "c"]);
    expect(bands[1]?.items.map((row) => row.id)).toEqual(["b"]);
  });

  it("partitions by Repository, on the short name the cell renders", () => {
    const bands = groupBranchRows(ROWS, grouping("repo"), ROWS);

    expect(bands.map((band) => band.label)).toEqual(["web", "api"]);
    expect(bands[1]?.items.map((row) => row.id)).toEqual(["b", "c"]);
  });

  it("partitions by PR / review state, on the status LABEL", () => {
    const bands = groupBranchRows(ROWS, grouping("status"), ROWS);

    expect(bands.map((band) => band.label)).toEqual(["Open", "Merged"]);
    expect(bands[0]?.items.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("bands an unrecognized status rather than throwing on it", () => {
    const unrecognized = [
      branchRow({ id: "x", status: "peer-review" as BranchRowStatus }),
    ];
    const bands = groupBranchRows(
      unrecognized,
      grouping("status"),
      unrecognized
    );

    expect(bands.map((band) => band.label)).toEqual(["Unknown"]);
  });

  it("names the empty Author and Repository bands as their cells do", () => {
    const empty = [branchRow({ id: "x", owner: "unattributed", repo: "—" })];

    expect(groupBranchRows(empty, grouping("owner"), empty)[0]?.label).toBe(
      "Unattributed"
    );
    // The word the repository CELL renders for a missing repo.
    expect(groupBranchRows(empty, grouping("repo"), empty)[0]?.label).toBe(
      "Unavailable"
    );
  });

  // The band's IDENTITY, not its rendered word. Keying on the label merged two
  // repositories whose short names collide into one band, reporting them as one.
  it("keeps repositories with a colliding short name in separate bands", () => {
    const colliding = [
      branchRow({ id: "a", repo: "acme/web" }),
      branchRow({ id: "b", repo: "other/web" }),
    ];
    const bands = groupBranchRows(colliding, grouping("repo"), colliding);

    expect(bands).toHaveLength(2);
    expect(bands.map((band) => band.label)).toEqual(["acme/web", "other/web"]);
  });

  // And the same for two people who share a display name: the row documents
  // `owner` as a name, so `ownerKey` is the only identity a band may key on.
  it("keeps two authors sharing a display name in separate bands", () => {
    const namesakes = [
      branchRow({ id: "a", owner: "Alex Rivera", ownerKey: "u1" }),
      branchRow({ id: "b", owner: "Alex Rivera", ownerKey: "u2" }),
    ];
    const bands = groupBranchRows(namesakes, grouping("owner"), namesakes);

    expect(bands).toHaveLength(2);
    expect(bands.map((band) => band.key)).toEqual(["u1", "u2"]);
    expect(bands.every((band) => band.label === "Alex Rivera")).toBe(true);
  });

  it("orders bands by the requested band order", () => {
    expect(
      groupBranchRows(
        ROWS,
        grouping("owner", TableGroupOrder.Descending),
        ROWS
      ).map((band) => band.label)
    ).toEqual(["Blake", "Alex"]);
    expect(
      groupBranchRows(
        ROWS,
        grouping("repo", TableGroupOrder.Ascending),
        ROWS
      ).map((band) => band.label)
    ).toEqual(["api", "web"]);
  });

  it("nests a secondary dimension as subgroups", () => {
    const bands = groupBranchRows(
      ROWS,
      grouping("owner", TableGroupOrder.Custom, "repo"),
      ROWS
    );

    expect(bands[0]?.subgroups?.map((band) => band.label)).toEqual([
      "api",
      "web",
    ]);
  });

  it("renders a flat list when nothing is grouped", () => {
    expect(groupBranchRows(ROWS, EMPTY_TABLE_GROUPING, ROWS)).toEqual([]);
  });

  // A field a later build stopped grouping by can still arrive from a restored
  // view. It must degrade to the flat list, not to one band of everything.
  it("renders a flat list for a field this build does not group by", () => {
    expect(groupBranchRows(ROWS, grouping("changes"), ROWS)).toEqual([]);
    expect(groupBranchRows(ROWS, grouping("__proto__"), ROWS)).toEqual([]);
  });
});

describe("groupUniversalBranchRows", () => {
  it("uses preserved producer evidence for champion status bands", () => {
    const rows = [
      branchRow({
        id: "future",
        rawStatus: "awaiting-robot-review",
        status: BranchRowStatus.Draft,
      }),
      branchRow({ id: "draft", status: BranchRowStatus.Draft }),
    ];

    const bands = groupUniversalBranchRows(rows, grouping("status"), rows);

    expect(bands.map((band) => band.label)).toEqual(["Unknown", "Draft"]);
    expect(bands.map((band) => band.items[0]?.id)).toEqual(["future", "draft"]);
  });

  it("applies canonical status labels to secondary groups too", () => {
    const rows = [
      branchRow({
        id: "future",
        owner: "Alex",
        rawStatus: "awaiting-robot-review",
        status: BranchRowStatus.Draft,
      }),
    ];

    const bands = groupUniversalBranchRows(
      rows,
      grouping("owner", TableGroupOrder.Custom, "status"),
      rows
    );

    expect(bands[0]?.subgroups?.[0]?.label).toBe("Unknown");
  });
});
