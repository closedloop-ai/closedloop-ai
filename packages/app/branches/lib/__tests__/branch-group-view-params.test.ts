import {
  MAX_COLLAPSED_GROUP_KEYS_PER_AXIS,
  TABLE_COLLAPSED_GROUP_PARAM,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { TABLE_GROUP_PARAM } from "@repo/app/shared/lib/table-group-view-params";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { buildSubgroupKey } from "@repo/design-system/lib/grid-table-v2-rows";
import { describe, expect, it } from "vitest";
import {
  parseBranchGroupViewParams,
  writeBranchGroupViewParams,
} from "../branch-filter-params";

/**
 * ISS-9582 — a Branches link carries its grouping axis and the bands collapsed
 * under it, so the reader it is sent to opens the view the sender was on.
 */

function level(fieldId: string, order: TableGroupOrder) {
  return { fieldId, order, showEmptyGroups: false };
}

const parse = (query: string) =>
  parseBranchGroupViewParams(new URLSearchParams(query));

describe("parseBranchGroupViewParams", () => {
  it("returns null when the link states no grouping", () => {
    expect(parse("")).toBeNull();
    expect(parse("status=open&page=2")).toBeNull();
  });

  it.each([
    TableGroupOrder.Custom,
    TableGroupOrder.Ascending,
    TableGroupOrder.Descending,
  ])("reads the %s order on both levels", (order) => {
    expect(parse(`group=owner:${order}&group=repo:${order}`)?.grouping).toEqual(
      {
        primary: level("owner", order),
        secondary: level("repo", order),
      }
    );
  });

  it("reads a bare field as the custom order the Group menu gives a new grouping", () => {
    expect(parse("group=repo")?.grouping).toEqual({
      primary: level("repo", TableGroupOrder.Custom),
      secondary: EMPTY_TABLE_GROUPING.secondary,
    });
  });

  it.each([
    ["an unknown field", "group=nope"],
    ["an inherited object key", "group=constructor"],
    ["a prototype key", "group=__proto__"],
    ["an order this build cannot spell", "group=repo:sideways"],
    ["an extra segment", "group=repo:asc:x"],
    ["more than two levels", "group=owner&group=repo&group=status"],
    ["one field on both levels", "group=repo&group=repo"],
    ["an empty value", "group="],
  ])("ignores the whole link view for %s", (_label, query) => {
    expect(parse(`${query}&collapsed=acme/web`)).toBeNull();
  });

  it("scopes collapsed keys to the linked axis", () => {
    expect(
      parse("group=repo&collapsed=acme/web&collapsed=acme/api")?.collapsedGroups
    ).toEqual({ "repo|": ["acme/web", "acme/api"] });
  });

  it("states every band open when the link names a grouping and no collapsed band", () => {
    expect(parse("group=repo")?.collapsedGroups).toEqual({});
  });

  it("ignores collapsed keys without a grouping to scope them", () => {
    expect(parse("collapsed=acme/web")).toBeNull();
  });

  it("keeps an unknown key, which matches no band, and dedupes and caps the rest", () => {
    const many = Array.from(
      { length: MAX_COLLAPSED_GROUP_KEYS_PER_AXIS + 10 },
      (_, i) => `collapsed=r${i}`
    ).join("&");
    const parsed = parse(`group=repo&collapsed=ghost&collapsed=ghost&${many}`);
    const keys = parsed?.collapsedGroups["repo|"] ?? [];
    expect(keys).toHaveLength(MAX_COLLAPSED_GROUP_KEYS_PER_AXIS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.at(-1)).toBe(`r${MAX_COLLAPSED_GROUP_KEYS_PER_AXIS + 9}`);
  });

  it("keeps the empty key, which is the Unavailable repository band", () => {
    expect(parse("group=repo&collapsed=")?.collapsedGroups).toEqual({
      "repo|": [""],
    });
  });
});

describe("writeBranchGroupViewParams", () => {
  const byOwnerThenRepo: TableGroupingState = {
    primary: level("owner", TableGroupOrder.Custom),
    secondary: level("repo", TableGroupOrder.Descending),
  };

  it("round-trips a two-level axis, its orders and its subgroup keys", () => {
    const subgroup = buildSubgroupKey("alice", "acme/web");
    const params = new URLSearchParams("status=open");
    writeBranchGroupViewParams(params, byOwnerThenRepo, {
      "owner|repo": [subgroup],
    });
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual([
      "owner:custom",
      "repo:desc",
    ]);
    expect(params.get("status")).toBe("open");
    expect(parseBranchGroupViewParams(params)).toEqual({
      collapsedGroups: { "owner|repo": [subgroup] },
      grouping: byOwnerThenRepo,
    });
  });

  it("writes only the active axis's bands", () => {
    const params = new URLSearchParams();
    writeBranchGroupViewParams(params, byOwnerThenRepo, {
      "owner|repo": ["alice"],
      "repo|": ["acme/web"],
    });
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["alice"]);
  });

  it("clears both params for an ungrouped view, and collapsed when nothing is", () => {
    const params = new URLSearchParams("group=repo&collapsed=acme/web&page=2");
    writeBranchGroupViewParams(params, EMPTY_TABLE_GROUPING, {
      "repo|": ["acme/web"],
    });
    expect(params.toString()).toBe("page=2");

    const open = new URLSearchParams("group=repo&collapsed=acme/web");
    writeBranchGroupViewParams(open, byOwnerThenRepo, {});
    expect(open.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual([]);
    expect(open.getAll(TABLE_GROUP_PARAM)).toHaveLength(2);
  });
});
