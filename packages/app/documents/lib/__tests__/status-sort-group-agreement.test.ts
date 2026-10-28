import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { buildDocumentGridGroups } from "@repo/app/documents/lib/documents-grid-groups";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { buildFlatItems } from "@repo/app/documents/lib/table-view-pipeline";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

/**
 * ISS-9669 — one documents table, one answer about where an unknown status goes.
 *
 * `Artifact.status` is a freeform column carrying two vocabularies, and branch
 * and session rows enter this table with statuses in NEITHER (a `GitHubPRState`,
 * a harness string). The sort comparator ranked such a row last; the group
 * assignment ranked it first, above `DRAFT`. Sorting the Status column and
 * grouping by Status therefore put the same row at opposite ends of the same
 * table.
 *
 * Both assertions below are load-bearing. The agreement check alone would stay
 * green if the two paths ever agreed on the WRONG end, so the placement is
 * pinned independently — and pinned to a literal index, not to
 * `STATUS_DISPLAY_ORDER.length`, which is the value under test.
 */
const UNKNOWN_STATUS = "MERGED";

describe("documents table: status sort and status grouping agree", () => {
  it("puts an unknown status in the same place when sorting and when grouping", () => {
    const items = rows();

    const sortedIds = buildFlatItems(
      items,
      undefined,
      SortKey.Status,
      "asc"
    ).map((item) => item.data.id);
    const groupedIds = buildDocumentGridGroups({
      groupBy: GroupByMode.Status,
      isGroupedView: false,
      groups: [],
      flatItems: items,
      groupOptions: {},
    }).flatMap((section) => section.items.map((item) => item.data.id));

    expect(groupedIds).toEqual(sortedIds);
  });

  it("ranks the unknown status last on BOTH paths, not first on one of them", () => {
    const items = rows();

    const sortedIds = buildFlatItems(
      items,
      undefined,
      SortKey.Status,
      "asc"
    ).map((item) => item.data.id);
    const groupLabels = buildDocumentGridGroups({
      groupBy: GroupByMode.Status,
      isGroupedView: false,
      groups: [],
      flatItems: items,
      groupOptions: {},
    }).map((section) => section.descriptor.key);

    // Three rows in, unknown last: index 2 of 3 on both paths.
    expect(sortedIds[2]).toBe("unknown-status-row");
    expect(groupLabels[2]).toBe(UNKNOWN_STATUS);
  });
});

function rows(): DocumentRowItem[] {
  return [
    row("unknown-status-row", UNKNOWN_STATUS),
    row("draft-row", DocumentStatus.Draft),
    row("approved-row", DocumentStatus.Approved),
  ];
}

function row(id: string, status: string): DocumentRowItem {
  // `status` is widened to `string` deliberately: `Artifact.status` is a
  // freeform column, and an out-of-vocabulary value is what this file is about.
  // Spreading a complete fixture keeps the cast a widening of ONE field rather
  // than an assertion over a partial object.
  return {
    kind: "document",
    data: {
      ...createMockDocument({ id, title: `Artifact ${id}`, slug: id }),
      status,
    } as DocumentWithProject,
  };
}
