import { Priority } from "@repo/api/src/types/common";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DocumentGridGroup } from "@repo/app/documents/lib/documents-grid-groups";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  buildCollapseVisibleItems,
  buildRenderedItems,
} from "@repo/app/documents/lib/table-view-pipeline";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

/**
 * ISS-12462 (PRD-720, DT-05/08/09): an identity can be a CHILD in an earlier
 * band and a ROOT in a later one. The grid paints it once, at its first
 * occurrence. Two projections read that body and must not be confused:
 *
 * - column collapse and select-all (`buildCollapseVisibleItems`, ISS-12640
 *   AC-3) follow what is PAINTED, so a descendant that only the unpainted later
 *   occurrence carries cannot keep a column visible or be selected;
 * - the logical population (`buildRenderedItems`) is the view's whole tree,
 *   including bands the reader closed.
 */
const SHARED_ID = "shared";
const EARLIER_ROOT_ID = "earlier-root";
const HIDDEN_URGENT_ID = "hidden-urgent";

function item(
  id: string,
  options: { children?: DocumentRowItem[]; priority?: Priority } = {}
): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({ id, priority: options.priority ?? Priority.Medium }),
    ...(options.children ? { children: options.children } : {}),
  };
}

function band(key: string, items: DocumentRowItem[]): DocumentGridGroup {
  return {
    descriptor: { key, label: key, mode: GroupByMode.Status },
    items,
    key,
    label: key,
  };
}

/**
 * `shared` sits under `earlier-root` in the first band with no subtree of its
 * own there, and roots the second band carrying an Urgent descendant.
 */
const GRID_GROUPS = [
  band("earlier", [item(EARLIER_ROOT_ID, { children: [item(SHARED_ID)] })]),
  band("later", [
    item(SHARED_ID, {
      children: [item(HIDDEN_URGENT_ID, { priority: Priority.Urgent })],
    }),
  ]),
];

const ARGS = {
  flatItems: [],
  gridGroups: GRID_GROUPS,
  groupBy: GroupByMode.Status,
  groups: [],
  isGroupExpanded: () => true,
  isGroupedView: true,
};

function ids(items: readonly DocumentRowItem[]): string[] {
  return items.map((row) => row.data.id);
}

describe("grouped projections over a repeated identity (ISS-12462)", () => {
  it("leaves the unpainted occurrence's descendants out of the column-collapse input", () => {
    const painted = buildCollapseVisibleItems({
      ...ARGS,
      isSectionExpanded: () => true,
    });

    expect(ids(painted)).toEqual([EARLIER_ROOT_ID, SHARED_ID]);
    expect(painted.some((row) => row.data.priority === Priority.Urgent)).toBe(
      false
    );
  });

  it("paints the later occurrence, and its Urgent descendant, once the earlier band is closed", () => {
    const painted = buildCollapseVisibleItems({
      ...ARGS,
      isSectionExpanded: (key) => key !== "earlier",
    });

    expect(ids(painted)).toEqual([SHARED_ID, HIDDEN_URGENT_ID]);
  });

  it("keeps the later root's logical subtree in the logical population", () => {
    // The logical population takes no band-collapse input at all.
    const logical = buildRenderedItems(ARGS);

    expect(ids(logical)).toEqual([
      EARLIER_ROOT_ID,
      SHARED_ID,
      HIDDEN_URGENT_ID,
    ]);
  });
});
