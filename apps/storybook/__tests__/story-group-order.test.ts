/**
 * Behavior tests for `story-group-order.ts`'s rank functions and the sort
 * order they build. `preview-story-sort-order.test.ts` pins the built order
 * against `preview.tsx`; what it never asks is how an UNLISTED level, group or
 * subgroup ranks, which is the documented fallback (sorts after everything
 * listed) and the half of each function that a typo in a story title lands on.
 */
import { describe, expect, it } from "vitest";
import {
  buildStorySortOrder,
  storybookBaselineRoot,
  storybookGroupRank,
  storybookLevelGroupOrder,
  storybookNextVersion,
  storybookPageTreeLevels,
  storybookPatternsV2Order,
  storybookPatternsV2Root,
  storybookStartHereGroupOrder,
  storybookSubgroupRank,
  storybookSurfacesV2Order,
  storybookSurfacesV2Root,
  storybookV2PageTreeOrder,
  storybookV2SharedGroup,
  storybookV2SharedOrder,
  storybookVersionedLevels,
  storybookVersionedRoot,
  storySortOrderPaths,
} from "../story-group-order";

describe("storybookGroupRank", () => {
  it("ranks listed groups by declaration order within their level", () => {
    const composites = storybookLevelGroupOrder.Composites ?? [];
    expect(storybookGroupRank("Composites", "Actions")).toBe(0);
    expect(storybookGroupRank("Composites", "Sessions")).toBe(
      composites.findIndex((group) => group.name === "Sessions")
    );
    expect(storybookGroupRank("Surfaces", "Documents")).toBeLessThan(
      storybookGroupRank("Surfaces", "Implementation Plans")
    );
  });

  it("ranks an unlisted group, and any group of an unknown level, after every listed one", () => {
    expect(storybookGroupRank("Surfaces", "Dashboard")).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(storybookGroupRank("Nope", "Actions")).toBe(Number.MAX_SAFE_INTEGER);
    expect(storybookGroupRank("Surfaces", "Dashboard")).toBeGreaterThan(
      storybookGroupRank("Surfaces", "Implementation Plans")
    );
  });
});

describe("storybookSubgroupRank", () => {
  it("ranks a listed subgroup by declaration order and an empty path first", () => {
    expect(storybookSubgroupRank("Composites", "Agents", "Detail")).toBe(0);
    expect(storybookSubgroupRank("Composites", "Agents", "General")).toBe(2);
    expect(storybookSubgroupRank("Primitives", "Data Display", "Tables")).toBe(
      0
    );
    expect(storybookSubgroupRank("Composites", "Agents", "")).toBe(-1);
  });

  it("ranks an unlisted subgroup last, whether its group has none, is unlisted, or its level is unknown", () => {
    expect(storybookSubgroupRank("Composites", "Branches", "Detail")).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(storybookSubgroupRank("Composites", "Agents", "Workbench")).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(storybookSubgroupRank("Composites", "Nowhere", "Detail")).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(storybookSubgroupRank("Nope", "Agents", "Detail")).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
});

describe("buildStorySortOrder", () => {
  it("leads with Start Here, then each level followed by its groups with subgroup lists riding behind their group", () => {
    const order = buildStorySortOrder();

    expect(order[0]).toBe("Start Here");
    expect(order[1]).toEqual(
      storybookStartHereGroupOrder.map((group) => group.name)
    );
    const compositesIndex = order.indexOf(storybookBaselineRoot("Composites"));
    const compositeChildren = order[compositesIndex + 1];
    expect(Array.isArray(compositeChildren)).toBe(true);
    const children = compositeChildren as readonly (
      | string
      | readonly string[]
    )[];
    expect(children[children.indexOf("Agents") + 1]).toEqual([
      "Detail",
      "Workspace",
      "General",
    ]);
    expect(children[children.indexOf("Branches") + 1]).toBe("Compute");
    expect(order.at(-2)).toBe(storybookBaselineRoot("Surfaces"));
    expect(order.at(-1)).toEqual(
      (storybookLevelGroupOrder.Surfaces ?? []).map((group) => group.name)
    );
  });

  it("lists every level's v1.0 root exactly once, each followed by one children array", () => {
    const order = buildStorySortOrder();
    const baselineRoots = Object.keys(storybookLevelGroupOrder).map(
      storybookBaselineRoot
    );
    const levels = order.filter(
      (node): node is string =>
        typeof node === "string" && baselineRoots.includes(node)
    );
    expect(levels).toEqual(baselineRoots);
    for (const level of levels) {
      expect(Array.isArray(order[order.indexOf(level) + 1])).toBe(true);
    }
    // Start Here, Patterns, Surfaces (ISS-11361) and each
    // versioned level's v2.0 root add a name and a children array beside the
    // levels.
    expect(order).toHaveLength(
      2 * (3 + storybookVersionedLevels.length) + 2 * levels.length
    );
  });

  it("lists every current root, in level order, above every v1.0 root", () => {
    const order = buildStorySortOrder();
    const roots = order.filter((node) => typeof node === "string");

    expect(roots).toEqual([
      "Start Here",
      "Foundations",
      "Primitives",
      "Composites",
      storybookPatternsV2Root,
      storybookSurfacesV2Root,
      ...Object.keys(storybookLevelGroupOrder).map(storybookBaselineRoot),
    ]);
  });

  it("gives each versioned level's v2.0 root its level's groups, or its Overview and the page tree for a page-tree level", () => {
    const order = buildStorySortOrder();

    for (const level of storybookVersionedLevels) {
      const v2Index = order.indexOf(
        storybookVersionedRoot(level, storybookNextVersion)
      );
      expect(v2Index).toBeGreaterThan(-1);
      expect(order[v2Index + 1]).toEqual(
        storybookPageTreeLevels.includes(level)
          ? ["Overview", ...storybookV2PageTreeOrder]
          : order[order.indexOf(storybookBaselineRoot(level)) + 1]
      );
    }
  });

  it("groups Composites and Patterns by the Surfaces tree, after Shared", () => {
    const order = buildStorySortOrder();
    const composites = order[order.indexOf("Composites") + 1];
    const patterns = order[order.indexOf(storybookPatternsV2Root) + 1];

    expect(storybookV2PageTreeOrder).toEqual([
      storybookV2SharedGroup,
      storybookV2SharedOrder,
      ...storybookSurfacesV2Order,
    ]);
    expect(composites).toEqual(["Overview", ...storybookV2PageTreeOrder]);
    expect(patterns).toEqual(["Overview", ...storybookV2PageTreeOrder]);
  });

  it("lists every node of an order tree as a path", () => {
    const paths = storySortOrderPaths(storybookV2PageTreeOrder);

    expect(paths.has("Shared/Artifact Detail")).toBe(true);
    expect(paths.has("Artifacts/Sessions/Session Detail")).toBe(true);
    expect(paths.has("Artifacts/Branches/Branch Detail")).toBe(true);
    expect(paths.has("Artifacts/Session Detail")).toBe(false);
  });

  it("puts the Surfaces tree last among the current roots, directly before Foundations v1.0", () => {
    const order = buildStorySortOrder();
    const v2Index = order.indexOf(storybookSurfacesV2Root);

    expect(order[v2Index + 1]).toEqual([
      "Overview",
      ...storybookSurfacesV2Order,
    ]);
    expect(order[v2Index + 2]).toBe(storybookBaselineRoot("Foundations"));
  });

  it("puts the Patterns tree directly before Surfaces", () => {
    const order = buildStorySortOrder();
    const patternsIndex = order.indexOf(storybookPatternsV2Root);

    expect(order[patternsIndex + 1]).toEqual(storybookPatternsV2Order);
    expect(order[patternsIndex + 2]).toBe(storybookSurfacesV2Root);
    expect(patternsIndex).toBeGreaterThan(
      order.indexOf(storybookVersionedRoot("Composites", storybookNextVersion))
    );
  });
});
