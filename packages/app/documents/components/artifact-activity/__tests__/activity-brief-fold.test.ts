import { describe, expect, it } from "vitest";
import {
  type ActivityBriefItem,
  ActivityBriefItemKind,
  activityBriefFoldLabel,
  foldActivityBrief,
} from "../activity-brief-fold";
import {
  activity,
  assignment,
  comment,
  EMILY,
  field,
  fieldChange,
  JAKE,
  status,
  versionRow,
} from "../activity-catalog.fixtures";
import type { ActivityTimelineRow } from "../activity-timeline";

/**
 * ISS-12579 (DI-09): how the issue's Activity brief folds its history. The
 * rules come from ISS-12570's review (Nerys, 2026-10-19): the ends always
 * show and the middle folds into one counted, named row. Since 2026-10-21
 * (Nerys, ISS-12576) comments fold with it: they live in the comments rail.
 */

let minute = 0;
const at = () => {
  minute += 1;
  return new Date(2026, 9, 1, 9, minute);
};

const statusRow = () =>
  activity(EMILY, at(), {
    action: status,
    before: field("status", "TODO"),
    after: field("status", "IN_PROGRESS"),
  });
const assigneeRow = () =>
  activity(EMILY, at(), {
    action: assignment,
    before: field("assigneeId", null),
    after: field("assigneeId", JAKE.id),
  });
const projectRow = () =>
  activity(EMILY, at(), {
    action: fieldChange,
    before: field("projectId", null),
    after: field("projectId", "p-1"),
  });
const commentRow = (id: string) => comment(JAKE, at(), id, "A reply");

function shape(items: readonly ActivityBriefItem[]) {
  return items.map((item) =>
    item.kind === ActivityBriefItemKind.Fold
      ? activityBriefFoldLabel(item)
      : item.row.kind
  );
}

describe("foldActivityBrief (ISS-12579)", () => {
  it("shows every row when the history fits both ends", () => {
    const rows = [statusRow(), statusRow(), statusRow(), statusRow()];
    expect(shape(foldActivityBrief(rows, 2))).toEqual([
      "activity",
      "activity",
      "activity",
      "activity",
    ]);
  });

  it("keeps the ends and folds the middle into one counted, named row", () => {
    const rows: ActivityTimelineRow[] = [
      statusRow(),
      statusRow(),
      projectRow(),
      statusRow(),
      assigneeRow(),
      projectRow(),
      statusRow(),
      statusRow(),
    ];
    expect(shape(foldActivityBrief(rows, 2))).toEqual([
      "activity",
      "activity",
      "Show 4 events: changed project, status, assignee",
      "activity",
      "activity",
    ]);
  });

  it("folds a comment in the middle with the events: it lives in the rail", () => {
    const rows: ActivityTimelineRow[] = [
      statusRow(),
      statusRow(),
      projectRow(),
      statusRow(),
      commentRow("t-1"),
      assigneeRow(),
      assigneeRow(),
      statusRow(),
      statusRow(),
    ];
    expect(shape(foldActivityBrief(rows, 2))).toEqual([
      "activity",
      "activity",
      "Show 5 events: changed project, status, assignee, and 1 more",
      "activity",
      "activity",
    ]);
  });

  it("folds a middle of only comments into a bare count: they name no field", () => {
    const rows: ActivityTimelineRow[] = [
      statusRow(),
      statusRow(),
      commentRow("t-3"),
      commentRow("t-4"),
      statusRow(),
      statusRow(),
    ];
    expect(shape(foldActivityBrief(rows, 2))).toEqual([
      "activity",
      "activity",
      "Show 2 events",
      "activity",
      "activity",
    ]);
  });

  it("shows a lone middle row instead of folding it, even a comment", () => {
    const rows: ActivityTimelineRow[] = [
      statusRow(),
      statusRow(),
      commentRow("t-2"),
      statusRow(),
      statusRow(),
    ];
    expect(shape(foldActivityBrief(rows, 2))).toEqual([
      "activity",
      "activity",
      "comment",
      "activity",
      "activity",
    ]);
  });

  it("counts events that name no field instead of folding them into a named change", () => {
    const rows: ActivityTimelineRow[] = [
      statusRow(),
      statusRow(),
      statusRow(),
      versionRow(EMILY, at(), 2),
      versionRow(EMILY, at(), 3),
      statusRow(),
      statusRow(),
    ];
    expect(shape(foldActivityBrief(rows, 2))).toEqual([
      "activity",
      "activity",
      "Show 3 events: changed status, and 2 more",
      "activity",
      "activity",
    ]);
  });

  it("names an assignment without a recorded role as an assignment, not an assignee", () => {
    const unroled = () =>
      activity(EMILY, at(), {
        action: assignment,
        before: null,
        after: null,
      });
    const rows: ActivityTimelineRow[] = [
      statusRow(),
      statusRow(),
      unroled(),
      assigneeRow(),
      statusRow(),
      statusRow(),
    ];
    expect(shape(foldActivityBrief(rows, 2))).toEqual([
      "activity",
      "activity",
      "Show 2 events: changed assignment, assignee",
      "activity",
      "activity",
    ]);
  });

  it("returns nothing for an empty history", () => {
    expect(foldActivityBrief([], 2)).toEqual([]);
  });
});
