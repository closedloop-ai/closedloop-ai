import { Priority } from "@repo/api/src/types/common";
import {
  EMPTY_TABLE_GROUPING,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import {
  PRIORITY_LABEL_NONE,
  PRIORITY_LABELS,
} from "@repo/design-system/lib/priority-order";
import { describe, expect, it } from "vitest";
import {
  SESSION_GROUP_UNSPECIFIED,
  SessionGroupBy,
} from "../../../lib/session-grouping";
import { SESSIONS_PRIORITY_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { buildGroups } from "../sessions-list-surface-rows";

/**
 * ISS-10332 (visual QA, 2026-09-22): the v2 surface bands Priority the way the
 * v1 table does — by RANK, never by the band's word — and names an omitted value
 * with the same word. A string sort put Ascending at High, Low, Medium, No
 * priority, Urgent, which reads as a ranking and is not one.
 */

const ROWS = [
  createSessionTableRowFixture({ id: "omitted" }),
  createSessionTableRowFixture({ id: "low", priority: Priority.Low }),
  createSessionTableRowFixture({ id: "none", priority: null }),
  createSessionTableRowFixture({ id: "urgent", priority: Priority.Urgent }),
  createSessionTableRowFixture({ id: "medium", priority: Priority.Medium }),
  createSessionTableRowFixture({ id: "high", priority: Priority.High }),
];

const RANKED = [
  PRIORITY_LABELS.URGENT,
  PRIORITY_LABELS.HIGH,
  PRIORITY_LABELS.MEDIUM,
  PRIORITY_LABELS.LOW,
  PRIORITY_LABEL_NONE,
  SESSION_GROUP_UNSPECIFIED,
];

function grouping(order: TableGroupOrder) {
  return {
    ...EMPTY_TABLE_GROUPING,
    primary: {
      fieldId: SESSIONS_PRIORITY_COLUMN_ID,
      order,
      showEmptyGroups: false,
    },
  };
}

describe("SessionsListSurfaceV2 groups by Priority (ISS-10332)", () => {
  it("orders Ascending bands by rank: most urgent first, unset after LOW, omitted last", () => {
    expect(
      buildGroups(ROWS, grouping(TableGroupOrder.Ascending)).map(
        (band) => band.label
      )
    ).toEqual(RANKED);
  });

  it("orders Descending bands as the exact reverse, not as a reverse string sort", () => {
    expect(
      buildGroups(ROWS, grouping(TableGroupOrder.Descending)).map(
        (band) => band.label
      )
    ).toEqual([...RANKED].reverse());
  });

  it("keeps Custom as first-appearance order, the producer's own", () => {
    expect(
      buildGroups(ROWS, grouping(TableGroupOrder.Custom)).map(
        (band) => band.label
      )
    ).toEqual([
      SESSION_GROUP_UNSPECIFIED,
      PRIORITY_LABELS.LOW,
      PRIORITY_LABEL_NONE,
      PRIORITY_LABELS.URGENT,
      PRIORITY_LABELS.MEDIUM,
      PRIORITY_LABELS.HIGH,
    ]);
  });

  it("bands an omitted value under the v1 table's word, so one saved view reads one way on both tables", () => {
    const bands = buildGroups(ROWS, grouping(TableGroupOrder.Ascending));
    const omitted = bands.find(
      (band) => band.label === SESSION_GROUP_UNSPECIFIED
    );
    expect(omitted?.items.map((item) => item.id)).toEqual(["omitted"]);
    // The dimension is the same value on both tables, so the band is named the
    // same everywhere — and the Priority group is the one that names it here.
    expect(SessionGroupBy.Priority).toBe(SESSIONS_PRIORITY_COLUMN_ID);
  });
});
