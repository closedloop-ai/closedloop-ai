/**
 * `collectRenderedGroupItems` decides which rows a grouped `GridTableV2` body
 * actually painted. ISS-8067 gave that answer a second consumer: it is now what
 * `Ctrl/Cmd+A` hands the host as "the visible rows", so a row this function
 * wrongly includes becomes a row the user selects without being able to see it.
 *
 * Tested here rather than through the grid because the SUBGROUP branch is
 * unreachable from any rendered surface in this repo — the Storybook demo's
 * `buildGroups` only ever emits one level — so a component test could not
 * exercise it at all. That unreachability is exactly why the pairing between
 * the key this module READS and the key the two group headers WRITE is pinned
 * by name below instead of being left to a template literal in three files.
 */

import {
  buildSubgroupKey,
  collectRenderedGroupItems,
} from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import { describe, expect, it } from "vitest";

type Row = { id: string };

const ALPHA: Row = { id: "alpha" };
const BETA: Row = { id: "beta" };
const GAMMA: Row = { id: "gamma" };

const FLAT_GROUPS = [
  { items: [ALPHA], key: "open", label: "Open" },
  { items: [BETA], key: "done", label: "Done" },
];

const NESTED_GROUPS = [
  {
    items: [],
    key: "open",
    label: "Open",
    subgroups: [
      { items: [ALPHA], key: "high", label: "High" },
      { items: [BETA], key: "low", label: "Low" },
    ],
  },
  { items: [GAMMA], key: "done", label: "Done" },
];

describe("collectRenderedGroupItems", () => {
  it("returns every row when nothing is collapsed", () => {
    expect(collectRenderedGroupItems(FLAT_GROUPS, new Set())).toEqual([
      ALPHA,
      BETA,
    ]);
  });

  it("drops a collapsed group's rows and keeps its siblings", () => {
    expect(collectRenderedGroupItems(FLAT_GROUPS, new Set(["open"]))).toEqual([
      BETA,
    ]);
  });

  it("paints a parent's SUBGROUP rows rather than its own", () => {
    // The parent carries `items: []` here, but the contract holds regardless:
    // a group with subgroups renders theirs, never its own.
    expect(collectRenderedGroupItems(NESTED_GROUPS, new Set())).toEqual([
      ALPHA,
      BETA,
      GAMMA,
    ]);
  });

  it("drops one collapsed subgroup without touching its sibling", () => {
    const collapsed = new Set([buildSubgroupKey("open", "high")]);

    expect(collectRenderedGroupItems(NESTED_GROUPS, collapsed)).toEqual([
      BETA,
      GAMMA,
    ]);
  });

  it("drops every subgroup when the PARENT is collapsed", () => {
    expect(collectRenderedGroupItems(NESTED_GROUPS, new Set(["open"]))).toEqual(
      [GAMMA]
    );
  });

  it("reads the same subgroup key the group headers write", () => {
    // Pinned as a LITERAL, not re-derived from `buildSubgroupKey`, or the pair
    // would agree with itself no matter what either side became. This is the
    // string `GridTableV2`'s two group headers put into `collapsedGroups`.
    expect(buildSubgroupKey("open", "high")).toBe("open/high");

    // The positive sibling: that exact literal is what suppresses the rows.
    expect(
      collectRenderedGroupItems(NESTED_GROUPS, new Set(["open/high"]))
    ).toEqual([BETA, GAMMA]);
  });

  it("leaves a subgroup rendered when only its bare key is collapsed", () => {
    // A subgroup key is namespaced by its parent, so the bare `high` must NOT
    // collapse it — the negative sibling that stops the assertion above from
    // passing under a helper that ignored its first argument.
    expect(collectRenderedGroupItems(NESTED_GROUPS, new Set(["high"]))).toEqual(
      [ALPHA, BETA, GAMMA]
    );
  });
});
