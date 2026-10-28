import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createSessionTableRowFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { buildGroups } from "@repo/app/agents/components/sessions/sessions-list-surface-rows";
import { buildUniversalSessionStatusBands } from "@repo/app/agents/lib/universal-session-status-grouping";
import { branchRow } from "@repo/app/branches/lib/__tests__/branch-row-fixture";
import { groupBranchRows } from "@repo/app/branches/lib/branch-column-view-model";
import {
  groupRowEntries,
  orderGroupEntries,
} from "@repo/app/shared/lib/table-grouping";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";

type Band = { label: string; items: string[] };

function entries(...labels: string[]): [string, Band][] {
  return labels.map((label, index) => [
    `key-${index}`,
    { label, items: [label] },
  ]);
}

function labelsOf(ordered: readonly (readonly [string, Band])[]): string[] {
  return ordered.map(([, band]) => band.label);
}

describe("orderGroupEntries", () => {
  it("keeps first-appearance order for Custom with no explicit order", () => {
    const ordered = orderGroupEntries(
      entries("Zeta", "alpha", "Mid"),
      TableGroupOrder.Custom,
      []
    );

    expect(labelsOf(ordered)).toEqual(["Zeta", "alpha", "Mid"]);
  });

  it("puts listed keys in the caller's order and unlisted keys after them", () => {
    const ordered = orderGroupEntries(
      entries("A", "B", "C", "D"),
      TableGroupOrder.Custom,
      ["key-2", "key-0"]
    );

    expect(labelsOf(ordered)).toEqual(["C", "A", "B", "D"]);
  });

  it("compares labels numerically and case-insensitively by default", () => {
    const ascending = orderGroupEntries(
      entries("item 10", "Item 2", "item 1"),
      TableGroupOrder.Ascending,
      []
    );
    const descending = orderGroupEntries(
      entries("item 10", "Item 2", "item 1"),
      TableGroupOrder.Descending,
      []
    );

    expect(labelsOf(ascending)).toEqual(["item 1", "Item 2", "item 10"]);
    expect(labelsOf(descending)).toEqual(["item 10", "Item 2", "item 1"]);
  });

  it("negates a caller comparator for Descending unless reverseDescending is set", () => {
    // A comparator that ties two bands: negation keeps their input order,
    // reversing the ascending result flips it. Branches relies on the reversal.
    const byFirstLetter = (
      [, left]: readonly [string, Band],
      [, right]: readonly [string, Band]
    ) => left.label.charCodeAt(0) - right.label.charCodeAt(0);
    const input = entries("b1", "a", "b2");

    expect(
      labelsOf(
        orderGroupEntries(input, TableGroupOrder.Descending, [], {
          compare: byFirstLetter,
        })
      )
    ).toEqual(["b1", "b2", "a"]);
    expect(
      labelsOf(
        orderGroupEntries(input, TableGroupOrder.Descending, [], {
          compare: byFirstLetter,
          reverseDescending: true,
        })
      )
    ).toEqual(["b2", "b1", "a"]);
  });
});

describe("groupRowEntries", () => {
  type Row = { id: string; key: string; label: string; value?: string };
  type Accumulator = {
    items: Row[];
    label: string;
    value?: string;
    conflicted: boolean;
  };

  function partitionRows(rows: readonly Row[], order?: TableGroupOrder) {
    return groupRowEntries(
      rows,
      ({ key, label, value }) => ({ key, label, value }),
      ({ label, value }, row): Accumulator => ({
        conflicted: value === undefined,
        items: [row],
        label,
        value,
      }),
      {
        order,
        appendContribution: (band, { value }) => {
          if (value === undefined || value !== band.value) {
            band.conflicted = true;
          }
        },
      }
    );
  }

  it("keeps bands with equal display labels apart when their keys differ", () => {
    const bands = partitionRows([
      { id: "1", key: "u1", label: "Alex Rivera", value: "u1" },
      { id: "2", key: "u2", label: "Alex Rivera", value: "u2" },
      { id: "3", key: "u1", label: "Alex Rivera", value: "u1" },
    ]);

    expect(bands.map(([key]) => key)).toEqual(["u1", "u2"]);
    expect(bands.map(([, band]) => band.items.map((row) => row.id))).toEqual([
      ["1", "3"],
      ["2"],
    ]);
  });

  it("hands every later row's contribution to the band it joins", () => {
    const bands = partitionRows([
      { id: "agree-1", key: "a", label: "A", value: "x" },
      { id: "agree-2", key: "a", label: "A", value: "x" },
      { id: "missing-1", key: "m", label: "M", value: "x" },
      { id: "missing-2", key: "m", label: "M" },
      { id: "conflict-1", key: "c", label: "C", value: "x" },
      { id: "conflict-2", key: "c", label: "C", value: "y" },
    ]);

    expect(
      Object.fromEntries(bands.map(([key, band]) => [key, band.conflicted]))
    ).toEqual({ a: false, c: true, m: true });
  });

  it("orders the built bands with the requested order", () => {
    const bands = partitionRows(
      [
        { id: "1", key: "b", label: "Beta" },
        { id: "2", key: "a", label: "Alpha" },
      ],
      TableGroupOrder.Ascending
    );

    expect(bands.map(([, band]) => band.label)).toEqual(["Alpha", "Beta"]);
  });
});

function branchGrouping(
  primary: string,
  order: TableGroupOrder,
  secondary: string | null = null
): TableGroupingState {
  return {
    primary: { fieldId: primary, order, showEmptyGroups: false },
    secondary: {
      fieldId: secondary,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
  };
}

describe("production callers of the shared band builder", () => {
  it("Branches keeps first-appearance Custom bands and ascending subgroups", () => {
    const rows = [
      branchRow({ id: "1", owner: "Blake", repo: "acme/web" }),
      branchRow({ id: "2", owner: "Alex", repo: "acme/web" }),
      branchRow({ id: "3", owner: "Blake", repo: "acme/api" }),
    ];

    const bands = groupBranchRows(
      rows,
      branchGrouping("owner", TableGroupOrder.Custom, "repo"),
      rows
    );

    expect(bands.map((band) => band.label)).toEqual(["Blake", "Alex"]);
    expect(bands[0]?.subgroups?.map((band) => band.label)).toEqual([
      "api",
      "web",
    ]);
  });

  it("Sessions bands a value only when every row in the band agrees on it", () => {
    const rows = [
      createSessionTableRowFixture({ id: "agree-1" }),
      createSessionTableRowFixture({ id: "agree-2" }),
      createSessionTableRowFixture({ id: "conflict-1" }),
      createSessionTableRowFixture({ id: "conflict-2" }),
      createSessionTableRowFixture({ id: "missing-1" }),
      createSessionTableRowFixture({ id: "missing-2" }),
    ];
    const contributions: Record<string, { key: string; value?: string }> = {
      "agree-1": { key: "Agree", value: "u1" },
      "agree-2": { key: "Agree", value: "u1" },
      "conflict-1": { key: "Conflict", value: "u1" },
      "conflict-2": { key: "Conflict", value: "u2" },
      "missing-1": { key: "Missing", value: "u1" },
      "missing-2": { key: "Missing" },
    };

    const bands = buildGroups(
      rows,
      {
        ...EMPTY_TABLE_GROUPING,
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
      },
      (_field, row) => contributions[row.id]
    );

    expect(
      bands.map(({ key, droppable, value }) => ({ key, droppable, value }))
    ).toEqual([
      { key: "Agree", droppable: true, value: "u1" },
      { key: "Conflict", droppable: false, value: undefined },
      { key: "Missing", droppable: false, value: undefined },
    ]);
  });

  it("Sessions status bands merge every row that shares a canonical status", () => {
    const bands = buildUniversalSessionStatusBands([
      createSessionTableRowFixture({
        id: "active-1",
        status: SESSION_STATUS.ACTIVE,
      }),
      createSessionTableRowFixture({
        id: "error",
        status: SESSION_STATUS.ERROR,
      }),
      createSessionTableRowFixture({
        id: "active-2",
        status: SESSION_STATUS.ACTIVE,
      }),
    ]);

    expect(
      bands.map((band) => ({
        ids: band.items.map((row) => row.id),
        value: band.value,
      }))
    ).toEqual([
      { ids: ["active-1", "active-2"], value: SESSION_STATUS.ACTIVE },
      { ids: ["error"], value: SESSION_STATUS.ERROR },
    ]);
  });
});
