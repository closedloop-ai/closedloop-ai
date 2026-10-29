import {
  TABLE_COLLAPSED_GROUP_PARAM,
  tableGroupingAxisKey,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  readTableGroupViewParams,
  TABLE_GROUP_EMPTY_PARAM,
  TABLE_GROUP_PARAM,
  writeTableGroupViewParams,
} from "@repo/app/shared/lib/table-group-view-params";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";

const COLON_FIELD = "custom:priority";
const SLASH_FIELD = "repo/owner";
const GROUPABLE = new Set([
  "status",
  "owner",
  "repo",
  COLON_FIELD,
  SLASH_FIELD,
]);

function isGroupable(field: string): boolean {
  return GROUPABLE.has(field);
}

function grouping(
  primary: string,
  primaryOrder: TableGroupOrder,
  secondary: string | null = null,
  secondaryOrder: TableGroupOrder = TableGroupOrder.Ascending
): TableGroupingState {
  return {
    primary: { fieldId: primary, order: primaryOrder, showEmptyGroups: false },
    secondary: {
      fieldId: secondary,
      order: secondaryOrder,
      showEmptyGroups: false,
    },
  };
}

function read(query: string, includeEmptyGroups = false) {
  return readTableGroupViewParams(
    new URLSearchParams(query),
    isGroupable,
    includeEmptyGroups
  );
}

describe("readTableGroupViewParams / writeTableGroupViewParams", () => {
  it("round-trips a two-level axis and its collapsed bands", () => {
    const view = grouping(
      "status",
      TableGroupOrder.Descending,
      "owner",
      TableGroupOrder.Custom
    );
    const axis = tableGroupingAxisKey(view) ?? "";
    const params = new URLSearchParams();

    writeTableGroupViewParams(params, view, { [axis]: ["Draft/Alex"] });

    expect(read(params.toString())).toEqual({
      grouping: view,
      collapsedGroups: { [axis]: ["Draft/Alex"] },
    });
  });

  it("reads a legacy bare field as the Custom order", () => {
    expect(read(`${TABLE_GROUP_PARAM}=repo`)?.grouping).toEqual({
      primary: {
        fieldId: "repo",
        order: TableGroupOrder.Custom,
        showEmptyGroups: false,
      },
      secondary: EMPTY_TABLE_GROUPING.secondary,
    });
  });

  it("encodes field ids carrying the separator or a slash", () => {
    const view = grouping(
      COLON_FIELD,
      TableGroupOrder.Ascending,
      SLASH_FIELD,
      TableGroupOrder.Descending
    );
    const params = new URLSearchParams();

    writeTableGroupViewParams(params, view, {});

    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual([
      `${encodeURIComponent(COLON_FIELD)}:${TableGroupOrder.Ascending}`,
      `${encodeURIComponent(SLASH_FIELD)}:${TableGroupOrder.Descending}`,
    ]);
    expect(read(params.toString())?.grouping).toEqual(view);
  });

  it.each([
    ["an ungroupable field", `${TABLE_GROUP_PARAM}=changes:asc`],
    ["an unknown order", `${TABLE_GROUP_PARAM}=status:sideways`],
    [
      "an ungroupable secondary level",
      `${TABLE_GROUP_PARAM}=status:asc&${TABLE_GROUP_PARAM}=changes:asc`,
    ],
    [
      "three levels",
      `${TABLE_GROUP_PARAM}=status&${TABLE_GROUP_PARAM}=owner&${TABLE_GROUP_PARAM}=repo`,
    ],
    [
      "the same field twice",
      `${TABLE_GROUP_PARAM}=status:asc&${TABLE_GROUP_PARAM}=status:desc`,
    ],
    ["an extra separator", `${TABLE_GROUP_PARAM}=status:asc:desc`],
    ["a malformed escape", `${TABLE_GROUP_PARAM}=%E0%A4%A:asc`],
    ["no grouping at all", `${TABLE_COLLAPSED_GROUP_PARAM}=Draft`],
  ])("rejects the whole axis for %s", (_case, query) => {
    expect(read(query)).toBeNull();
  });

  it("reads and writes groupEmpty only when the surface opts in", () => {
    const view: TableGroupingState = {
      primary: {
        fieldId: "status",
        order: TableGroupOrder.Ascending,
        showEmptyGroups: true,
      },
      secondary: {
        fieldId: "owner",
        order: TableGroupOrder.Ascending,
        showEmptyGroups: false,
      },
    };
    const optedIn = new URLSearchParams();
    const optedOut = new URLSearchParams(`${TABLE_GROUP_EMPTY_PARAM}=keep`);

    writeTableGroupViewParams(optedIn, view, {}, true);
    writeTableGroupViewParams(optedOut, view, {});

    expect(optedIn.getAll(TABLE_GROUP_EMPTY_PARAM)).toEqual(["true", "false"]);
    expect(read(optedIn.toString(), true)?.grouping).toEqual(view);
    expect(read(optedIn.toString())?.grouping.primary.showEmptyGroups).toBe(
      false
    );
    expect(optedOut.getAll(TABLE_GROUP_EMPTY_PARAM)).toEqual(["keep"]);
  });

  it("preserves unrelated parameters", () => {
    const params = new URLSearchParams("sort=name&page=3");

    writeTableGroupViewParams(
      params,
      grouping("status", TableGroupOrder.Ascending),
      {}
    );

    expect(params.get("sort")).toBe("name");
    expect(params.get("page")).toBe("3");
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual(["status:asc"]);
  });

  it("clears grouping and collapse when the view is ungrouped", () => {
    const params = new URLSearchParams(
      `${TABLE_GROUP_PARAM}=status:asc&${TABLE_COLLAPSED_GROUP_PARAM}=Draft&sort=name`
    );

    writeTableGroupViewParams(params, EMPTY_TABLE_GROUPING, {
      "status|": ["Draft"],
    });

    expect(params.has(TABLE_GROUP_PARAM)).toBe(false);
    expect(params.has(TABLE_COLLAPSED_GROUP_PARAM)).toBe(false);
    expect(params.get("sort")).toBe("name");
  });
});
