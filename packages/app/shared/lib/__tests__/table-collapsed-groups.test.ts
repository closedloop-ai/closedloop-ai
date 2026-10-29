import {
  collapsedGroupsEqual,
  MAX_COLLAPSED_GROUP_KEYS_PER_AXIS,
  nextCollapsedGroups,
  overlayLinkedCollapsedGroups,
  PERSISTED_COLLAPSED_GROUPS_SCHEMA,
  readTableCollapsedGroupParams,
  renderedTableGroupKeys,
  TABLE_COLLAPSED_GROUP_PARAM,
  type TableCollapsedGroups,
  tableGroupCollapsePort,
  tableGroupingAxisKey,
  writeTableCollapsedGroupParams,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { buildSubgroupKey } from "@repo/design-system/lib/grid-table-v2-rows";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import { describe, expect, it, vi } from "vitest";

const BY_REPO: TableGroupingState = {
  primary: {
    fieldId: "repo",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
  secondary: EMPTY_TABLE_GROUPING.secondary,
};
const BY_OWNER_THEN_REPO: TableGroupingState = {
  primary: { ...BY_REPO.primary, fieldId: "owner" },
  secondary: { ...BY_REPO.primary, fieldId: "repo" },
};
const REPO_AXIS = "repo|";
const OWNER_REPO_AXIS = "owner|repo";

function band(key: string, subgroups?: string[]): GridTableV2Group<string> {
  return {
    items: [],
    key,
    label: key,
    subgroups: subgroups?.map((sub) => ({ items: [], key: sub, label: sub })),
  };
}

const PAGED = (keys: string[]) => ({
  isCompletePopulation: false,
  renderedKeys: new Set(keys),
});
const COMPLETE = (keys: string[]) => ({
  isCompletePopulation: true,
  renderedKeys: new Set(keys),
});

describe("tableGroupingAxisKey", () => {
  it("names both levels, and null when ungrouped", () => {
    expect(tableGroupingAxisKey(BY_REPO)).toBe(REPO_AXIS);
    expect(tableGroupingAxisKey(BY_OWNER_THEN_REPO)).toBe(OWNER_REPO_AXIS);
    expect(tableGroupingAxisKey(EMPTY_TABLE_GROUPING)).toBeNull();
  });

  it("ignores order and showEmptyGroups", () => {
    expect(
      tableGroupingAxisKey({
        ...BY_REPO,
        primary: {
          ...BY_REPO.primary,
          order: TableGroupOrder.Descending,
          showEmptyGroups: true,
        },
      })
    ).toBe(REPO_AXIS);
  });
});

describe("PERSISTED_COLLAPSED_GROUPS_SCHEMA", () => {
  it("degrades a missing or non-object value to nothing collapsed", () => {
    expect(PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse(undefined)).toEqual({});
    expect(PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse("acme/web")).toEqual({});
    expect(PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse(["acme/web"])).toEqual({});
    expect(PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse(null)).toEqual({});
  });

  it("drops junk entries, empty axes, and keys that are not axes", () => {
    const parsed = PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse(
      JSON.parse(
        `{"repo|":["acme/web",7,"acme/web",null,"acme/api"],"owner|":[],"status|":"merged","__proto__":["x"],"constructor":["y"]}`
      )
    );
    expect(parsed).toEqual({ "repo|": ["acme/web", "acme/api"] });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("caps an axis at the newest keys and caps the number of axes", () => {
    const keys = Array.from({ length: 100 }, (_, i) => `r${i}`);
    const axes = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`f${i}|`, ["k"]])
    );
    const parsed = PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse({
      ...axes,
      "repo|": keys,
    });
    expect(Object.keys(parsed)).toHaveLength(MAX_COLLAPSED_GROUP_KEYS_PER_AXIS);
    // A key repeated at the end is the newest, so the cap must keep it.
    const repeated = PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse({
      "repo|": [...keys, "r0"],
    });
    expect(repeated["repo|"]?.at(-1)).toBe("r0");
    expect(repeated["repo|"]).toHaveLength(MAX_COLLAPSED_GROUP_KEYS_PER_AXIS);
    const long = PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse({ "repo|": keys });
    expect(long["repo|"]).toEqual(
      keys.slice(-MAX_COLLAPSED_GROUP_KEYS_PER_AXIS)
    );
  });
});

describe("collapsedGroupsEqual", () => {
  it("compares each axis as a set and reads an empty axis as absent", () => {
    expect(
      collapsedGroupsEqual(
        { [REPO_AXIS]: ["a/b", "c/d"] },
        { [REPO_AXIS]: ["c/d", "a/b"], [OWNER_REPO_AXIS]: [] }
      )
    ).toBe(true);
  });

  it("tells apart one more collapsed band, and the same key on another axis", () => {
    expect(
      collapsedGroupsEqual(
        { [REPO_AXIS]: ["a/b"] },
        { [REPO_AXIS]: ["a/b", "c/d"] }
      )
    ).toBe(false);
    expect(
      collapsedGroupsEqual(
        { [REPO_AXIS]: ["a/b"] },
        { [OWNER_REPO_AXIS]: ["a/b"] }
      )
    ).toBe(false);
  });
});

describe("renderedTableGroupKeys", () => {
  it("lists band keys and composed subgroup keys", () => {
    expect(
      renderedTableGroupKeys([band("alice", ["acme/web"]), band("bob")])
    ).toEqual(new Set(["alice", buildSubgroupKey("alice", "acme/web"), "bob"]));
  });
});

describe("nextCollapsedGroups", () => {
  it("on a paged list, keeps a collapsed band that sits on another page", () => {
    const next = nextCollapsedGroups(
      { [REPO_AXIS]: ["acme/api"] },
      REPO_AXIS,
      "acme/web",
      true,
      PAGED(["acme/web"])
    );
    expect(next[REPO_AXIS]).toEqual(["acme/api", "acme/web"]);
  });

  it("with the whole population on the page, drops a key that names no band", () => {
    const next = nextCollapsedGroups(
      { [REPO_AXIS]: ["ghost/repo", "acme/api"] },
      REPO_AXIS,
      "acme/web",
      true,
      COMPLETE(["acme/web", "acme/api"])
    );
    expect(next[REPO_AXIS]).toEqual(["acme/api", "acme/web"]);
  });

  it("opening the last collapsed band removes the axis and leaves others alone", () => {
    const next = nextCollapsedGroups(
      { [OWNER_REPO_AXIS]: ["alice"], [REPO_AXIS]: ["acme/web"] },
      REPO_AXIS,
      "acme/web",
      false,
      PAGED(["acme/web"])
    );
    expect(next).toEqual({ [OWNER_REPO_AXIS]: ["alice"] });
  });

  it("evicts the oldest key at the cap, never the band just closed", () => {
    const full = Array.from(
      { length: MAX_COLLAPSED_GROUP_KEYS_PER_AXIS },
      (_, i) => `r${i}`
    );
    const next = nextCollapsedGroups(
      { [REPO_AXIS]: full },
      REPO_AXIS,
      "newest",
      true,
      PAGED(["newest"])
    );
    expect(next[REPO_AXIS]).toHaveLength(MAX_COLLAPSED_GROUP_KEYS_PER_AXIS);
    expect(next[REPO_AXIS]).not.toContain("r0");
    expect(next[REPO_AXIS]?.at(-1)).toBe("newest");
  });

  it("switching axis and back keeps the first axis's bands", () => {
    const repo = nextCollapsedGroups(
      {},
      REPO_AXIS,
      "acme/web",
      true,
      PAGED(["acme/web"])
    );
    const owner = nextCollapsedGroups(
      repo,
      OWNER_REPO_AXIS,
      "alice",
      true,
      PAGED(["alice"])
    );
    expect(owner[REPO_AXIS]).toEqual(["acme/web"]);
  });
});

describe("tableGroupCollapsePort", () => {
  it("is absent without host state or grouping, so the grid owns collapse", () => {
    const groups = [band("acme/web")];
    expect(
      tableGroupCollapsePort({
        collapsedGroups: undefined,
        grouping: BY_REPO,
        groups,
        isCompletePopulation: true,
        onCollapsedGroupsChange: vi.fn(),
      })
    ).toBeUndefined();
    expect(
      tableGroupCollapsePort({
        collapsedGroups: {},
        grouping: EMPTY_TABLE_GROUPING,
        groups,
        isCompletePopulation: true,
        onCollapsedGroupsChange: vi.fn(),
      })
    ).toBeUndefined();
  });

  it("answers only for the active axis — the `/` collision stays on its own axis", () => {
    // `alice/acme` is a repository band under `repo|` and alice's `acme`
    // subgroup under `owner|repo`: one string, two bands.
    const stored: TableCollapsedGroups = { [REPO_AXIS]: ["alice/acme"] };
    const byOwner = tableGroupCollapsePort({
      collapsedGroups: stored,
      grouping: BY_OWNER_THEN_REPO,
      groups: [band("alice", ["acme"])],
      isCompletePopulation: true,
      onCollapsedGroupsChange: vi.fn(),
    });
    expect(byOwner?.isCollapsed(buildSubgroupKey("alice", "acme"))).toBe(false);

    const byRepo = tableGroupCollapsePort({
      collapsedGroups: stored,
      grouping: BY_REPO,
      groups: [band("alice/acme")],
      isCompletePopulation: true,
      onCollapsedGroupsChange: vi.fn(),
    });
    expect(byRepo?.isCollapsed("alice/acme")).toBe(true);
  });

  it("writes a toggle back under the active axis", () => {
    const onChange = vi.fn();
    const port = tableGroupCollapsePort({
      collapsedGroups: { [OWNER_REPO_AXIS]: ["bob"] },
      grouping: BY_REPO,
      groups: [band("acme/web")],
      isCompletePopulation: false,
      onCollapsedGroupsChange: onChange,
    });
    port?.setCollapsed("acme/web", true);
    expect(onChange).toHaveBeenCalledWith({
      [OWNER_REPO_AXIS]: ["bob"],
      [REPO_AXIS]: ["acme/web"],
    });
  });
});

describe("readTableCollapsedGroupParams / writeTableCollapsedGroupParams", () => {
  function collapsedQuery(keys: readonly string[]): URLSearchParams {
    const params = new URLSearchParams("sort=name");
    for (const key of keys) {
      params.append(TABLE_COLLAPSED_GROUP_PARAM, key);
    }
    return params;
  }

  it("restores linked keys under the active axis only", () => {
    expect(
      readTableCollapsedGroupParams(
        collapsedQuery(["alice", "bob"]),
        BY_OWNER_THEN_REPO
      )
    ).toEqual({ [OWNER_REPO_AXIS]: ["alice", "bob"] });
  });

  it("ignores collapse when nothing is grouped", () => {
    expect(
      readTableCollapsedGroupParams(
        collapsedQuery(["alice"]),
        EMPTY_TABLE_GROUPING
      )
    ).toEqual({});
  });

  it("dedupes repeated keys and bounds the list, keeping the newest", () => {
    const keys = Array.from(
      { length: MAX_COLLAPSED_GROUP_KEYS_PER_AXIS + 5 },
      (_, index) => `band-${index}`
    );
    const restored = readTableCollapsedGroupParams(
      collapsedQuery(["band-0", ...keys]),
      BY_REPO
    )[REPO_AXIS];

    expect(restored).toHaveLength(MAX_COLLAPSED_GROUP_KEYS_PER_AXIS);
    expect(restored?.at(-1)).toBe(keys.at(-1));
    expect(restored).not.toContain("band-0");
  });

  it("round-trips composed subgroup keys holding slashes and commas", () => {
    const composed = buildSubgroupKey("acme/web, api", "alice,bob");
    const params = new URLSearchParams("sort=name");

    writeTableCollapsedGroupParams(params, BY_OWNER_THEN_REPO, {
      [OWNER_REPO_AXIS]: [composed, "carol"],
    });

    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual([
      composed,
      "carol",
    ]);
    expect(
      readTableCollapsedGroupParams(
        new URLSearchParams(params.toString()),
        BY_OWNER_THEN_REPO
      )
    ).toEqual({ [OWNER_REPO_AXIS]: [composed, "carol"] });
  });

  it("writes only the active axis and keeps unrelated parameters", () => {
    const params = collapsedQuery(["stale"]);

    writeTableCollapsedGroupParams(params, BY_REPO, {
      [OWNER_REPO_AXIS]: ["alice"],
      [REPO_AXIS]: ["acme/web"],
    });

    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["acme/web"]);
    expect(params.get("sort")).toBe("name");
  });

  it("clears collapse when the view is ungrouped", () => {
    const params = collapsedQuery(["stale"]);

    writeTableCollapsedGroupParams(params, EMPTY_TABLE_GROUPING, {
      [REPO_AXIS]: ["acme/web"],
    });

    expect(params.has(TABLE_COLLAPSED_GROUP_PARAM)).toBe(false);
  });
});

describe("overlayLinkedCollapsedGroups", () => {
  const stored: TableCollapsedGroups = {
    [OWNER_REPO_AXIS]: ["alex"],
    [REPO_AXIS]: ["acme/api"],
  };

  it("replaces only the linked axis, keeping every other stored axis", () => {
    expect(
      overlayLinkedCollapsedGroups(stored, {
        collapsedGroups: { [REPO_AXIS]: ["acme/web"] },
        grouping: BY_REPO,
      })
    ).toEqual({ [OWNER_REPO_AXIS]: ["alex"], [REPO_AXIS]: ["acme/web"] });
  });

  it("reads a linked axis with nothing collapsed as fully open", () => {
    expect(
      overlayLinkedCollapsedGroups(stored, {
        collapsedGroups: {},
        grouping: BY_REPO,
      })
    ).toEqual({ [OWNER_REPO_AXIS]: ["alex"] });
  });

  it("leaves the stored record alone for an ungrouped link", () => {
    expect(
      overlayLinkedCollapsedGroups(stored, {
        collapsedGroups: {},
        grouping: EMPTY_TABLE_GROUPING,
      })
    ).toEqual(stored);
  });
});
