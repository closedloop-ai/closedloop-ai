/**
 * The pure half of `GridTableV2`'s parent/child row lineage (ISS-8921):
 * flattening a sibling set into the rows a body paints, the ARIA those rows
 * declare, and the bound on the expansion set.
 *
 * These are asserted without rendering because they are where the contract
 * actually lives — a rendered assertion could pass while the helper produced the
 * wrong `aria-setsize` for a set the fixture happened not to exercise.
 */

import { buildTreeIndentStyle } from "@closedloop-ai/design-system/components/ui/grid-table-v2-tree-lead";
import { collectRenderedGroupItems } from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import {
  collectExpandableRowIds,
  createSiblingFlattener,
  FIRST_TREE_LEVEL,
  flattenRenderRows,
  nextExpandedRowIds,
  treeRowAriaProps,
} from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import type { GridTableV2Group } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import { describe, expect, it } from "vitest";

type Node = { id: string; children?: Node[] };

const getRowId = (node: Node) => node.id;
const getChildren = (node: Node) => node.children;

/**
 * Two roots. The first owns three children so `aria-setsize` has a value that
 * differs from the root set's — a fixture where both sets were the same size
 * could not tell "siblings" from "every row".
 */
const TREE: Node[] = [
  {
    id: "a",
    children: [
      { id: "a1" },
      { id: "a2", children: [{ id: "a2x" }] },
      { id: "a3" },
    ],
  },
  { id: "b" },
];

function flatten(expanded: string[]) {
  return flattenRenderRows({
    expandedRowIds: new Set(expanded),
    getChildren,
    getRowId,
    items: TREE,
  });
}

describe("flattenRenderRows without a child accessor", () => {
  it("returns one tree-less row per item, in the input order", () => {
    const rows = flattenRenderRows({ getRowId, items: TREE });

    expect(rows.map((row) => row.rowId)).toEqual(["a", "b"]);
    // `null` is what makes flatness inert downstream: there is no metadata for
    // an ARIA derivation to emit, rather than metadata a guard has to suppress.
    expect(rows.map((row) => row.tree)).toEqual([null, null]);
  });

  it("ignores expansion state it was handed anyway", () => {
    const rows = flattenRenderRows({
      expandedRowIds: new Set(["a"]),
      getRowId,
      items: TREE,
    });

    expect(rows.map((row) => row.rowId)).toEqual(["a", "b"]);
  });
});

describe("flattenRenderRows with a child accessor", () => {
  it("paints only the roots while nothing is expanded", () => {
    expect(flatten([]).map((row) => row.rowId)).toEqual(["a", "b"]);
  });

  it("marks which roots own children", () => {
    expect(flatten([]).map((row) => row.tree?.hasChildren)).toEqual([
      true,
      false,
    ]);
  });

  it("interleaves an expanded row's children directly beneath it", () => {
    expect(flatten(["a"]).map((row) => row.rowId)).toEqual([
      "a",
      "a1",
      "a2",
      "a3",
      "b",
    ]);
  });

  it("numbers levels from the root down", () => {
    expect(flatten(["a", "a2"]).map((row) => row.tree?.level)).toEqual([
      1, 2, 2, 3, 2, 1,
    ]);
  });

  it("sizes a set by its own siblings, not by the rows on screen", () => {
    const rows = flatten(["a"]);

    expect(
      rows.map((row) => `${row.tree?.posInSet}/${row.tree?.setSize}`)
    ).toEqual(["1/2", "1/3", "2/3", "3/3", "2/2"]);
  });

  it("reports a row as expanded only while it owns children", () => {
    // "b" is a leaf. An expansion id naming it must not make it read as open,
    // or a leaf would announce a disclosure that does not exist.
    expect(flatten(["b"]).map((row) => row.tree?.isExpanded)).toEqual([
      false,
      false,
    ]);
  });

  it("numbers a set by the siblings it PAINTED, not the ones it was given", () => {
    // `dup` was already painted under "a", so the guard drops it here. If the
    // set arithmetic still counted it, the two survivors would announce "1 of 3"
    // and "3 of 3" — a set with a member no navigation can ever reach.
    const shared: Node = { id: "dup" };
    const rows = flattenRenderRows({
      expandedRowIds: new Set(["a", "z"]),
      getChildren,
      getRowId,
      items: [
        { children: [shared], id: "a" },
        { children: [{ id: "x" }, shared, { id: "y" }], id: "z" },
      ],
    });

    const painted = rows.filter(
      (row) => row.tree?.level === 2 && row.rowId !== "dup"
    );
    expect(painted.map((row) => row.rowId)).toEqual(["x", "y"]);
    expect(
      painted.map((row) => `${row.tree?.posInSet}/${row.tree?.setSize}`)
    ).toEqual(["1/2", "2/2"]);
  });

  it("paints a self-referencing lineage once instead of recursing forever", () => {
    const loop: Node = { id: "loop" };
    loop.children = [loop];

    const rows = flattenRenderRows({
      expandedRowIds: new Set(["loop"]),
      getChildren,
      getRowId,
      items: [loop],
    });

    expect(rows.map((row) => row.rowId)).toEqual(["loop"]);
  });
});

/**
 * whitlockk review: the guard has to span a body assembled from more than one list.
 *
 * A grouped body flattens a band at a time, and a bare `flattenRenderRows`
 * guards for one call, so the repeat-paints-once contract stopped at the band
 * boundary. Both halves are pinned here — that one flattener carries the guard
 * across its calls, and that a NEW one starts clean — because a factory that got
 * the second half wrong would paint an empty card fallback beside a full grid.
 */
describe("createSiblingFlattener", () => {
  const REPEATED: Node = { id: "shared" };

  it("carries its cycle guard across every list it is handed", () => {
    const flatten = createSiblingFlattener({ getChildren, getRowId });

    expect(
      flatten([REPEATED, { id: "first" }]).map((row) => row.rowId)
    ).toEqual(["shared", "first"]);
    expect(
      flatten([REPEATED, { id: "second" }]).map((row) => row.rowId)
    ).toEqual(["second"]);
  });

  it("numbers the later list by the siblings it actually painted", () => {
    const flatten = createSiblingFlattener({ getChildren, getRowId });
    flatten([REPEATED]);

    const rows = flatten([REPEATED, { id: "second" }]);

    expect(
      rows.map((row) => `${row.tree?.posInSet}/${row.tree?.setSize}`)
    ).toEqual(["1/1"]);
  });

  it("starts a fresh guard per flattener, so a second pass paints in full", () => {
    const first = createSiblingFlattener({ getChildren, getRowId });
    first([REPEATED]);

    const second = createSiblingFlattener({ getChildren, getRowId });

    expect(second([REPEATED]).map((row) => row.rowId)).toEqual(["shared"]);
  });
});

describe("treeRowAriaProps", () => {
  it("emits nothing at all for a flat row", () => {
    expect(treeRowAriaProps(null)).toEqual({});
  });

  it("emits the position triple for a nested row", () => {
    expect(
      treeRowAriaProps({
        hasChildren: false,
        isExpanded: false,
        level: 2,
        posInSet: 3,
        setSize: 4,
      })
    ).toEqual({
      "aria-level": 2,
      "aria-posinset": 3,
      "aria-setsize": 4,
    });
  });

  it("adds aria-expanded only for a row that owns children", () => {
    expect(
      treeRowAriaProps({
        hasChildren: true,
        isExpanded: true,
        level: FIRST_TREE_LEVEL,
        posInSet: 1,
        setSize: 1,
      })
    ).toMatchObject({ "aria-expanded": true });
  });
});

describe("collectExpandableRowIds", () => {
  it("reaches ids inside subtrees the user has closed", () => {
    // "a2" is only reachable through "a". Missing it is what would make the
    // expansion bound forget a grandchild's open state on the next toggle.
    expect(
      collectExpandableRowIds({ getChildren, getRowId, items: TREE })
    ).toEqual(new Set(["a", "a2"]));
  });

  it("terminates on a self-referencing lineage", () => {
    const loop: Node = { id: "loop" };
    loop.children = [loop];

    expect(
      collectExpandableRowIds({ getChildren, getRowId, items: [loop] })
    ).toEqual(new Set(["loop"]));
  });
});

describe("nextExpandedRowIds", () => {
  const expandableRowIds = new Set(["a", "a2"]);

  it("opens a row", () => {
    expect(
      nextExpandedRowIds({
        expandableRowIds,
        expanded: true,
        previous: new Set(),
        rowId: "a",
      })
    ).toEqual(new Set(["a"]));
  });

  it("closes a row without disturbing its siblings", () => {
    expect(
      nextExpandedRowIds({
        expandableRowIds,
        expanded: false,
        previous: new Set(["a", "a2"]),
        rowId: "a",
      })
    ).toEqual(new Set(["a2"]));
  });

  it("drops ids the current tree can no longer expand", () => {
    // The bound. Without it the set keeps an id for every row ever opened
    // across every page and filter the session walked through.
    expect(
      nextExpandedRowIds({
        expandableRowIds,
        expanded: true,
        previous: new Set(["a", "gone-with-the-last-page", "also-gone"]),
        rowId: "a2",
      })
    ).toEqual(new Set(["a", "a2"]));
  });
});

describe("collectRenderedGroupItems with lineage", () => {
  const GROUPS: GridTableV2Group<Node>[] = [
    { items: [TREE[0] as Node], key: "open", label: "Open" },
    { items: [TREE[1] as Node], key: "done", label: "Done" },
  ];
  const expandSiblings = (items: readonly Node[]) =>
    flattenRenderRows({
      expandedRowIds: new Set(["a"]),
      getChildren,
      getRowId,
      items,
    }).map((row) => row.item);

  it("expands each band's roots in place", () => {
    expect(
      collectRenderedGroupItems(GROUPS, new Set(), expandSiblings).map(getRowId)
    ).toEqual(["a", "a1", "a2", "a3", "b"]);
  });

  it("still drops a collapsed band and everything under it", () => {
    expect(
      collectRenderedGroupItems(GROUPS, new Set(["open"]), expandSiblings).map(
        getRowId
      )
    ).toEqual(["b"]);
  });

  it("is unchanged for a caller that passes no expander", () => {
    expect(collectRenderedGroupItems(GROUPS, new Set()).map(getRowId)).toEqual([
      "a",
      "b",
    ]);
  });
});

/**
 * The indent is the SIGHTED half of depth — `aria-level` is the other half, and
 * the two are independent renderings of the same fact. Without this, deleting
 * the indent entirely would leave every ARIA assertion green while the table
 * painted every level flush left.
 */
describe("buildTreeIndentStyle", () => {
  it("declares no indentation at all for a root row", () => {
    expect(buildTreeIndentStyle(FIRST_TREE_LEVEL)).toBeUndefined();
  });

  it("indents one full control track per level below the root", () => {
    // The disclosure box plus the gap beside it, read from the same tokens that
    // lay that track out — sizing it to the GLYPH instead lands a child's
    // chevron inside its parent's gap, aligned with nothing.
    expect(buildTreeIndentStyle(FIRST_TREE_LEVEL + 1)).toEqual({
      paddingInlineStart: "calc((var(--icon-lg) + var(--density-cozy)) * 1)",
    });
  });

  it("scales the indent with depth", () => {
    expect(buildTreeIndentStyle(FIRST_TREE_LEVEL + 3)).toEqual({
      paddingInlineStart: "calc((var(--icon-lg) + var(--density-cozy)) * 3)",
    });
  });
});
