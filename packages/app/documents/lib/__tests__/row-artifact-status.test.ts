import {
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { buildDocumentGridGroups } from "@repo/app/documents/lib/documents-grid-groups";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  rowArtifactStatus,
  STORED_SESSION_STATUS_ROW_OPTIONS,
} from "@repo/app/documents/lib/row-artifact-status";
import {
  buildFlatItems,
  DEFAULT_TABLE_VIEW_ORDERING,
  rootFirstTableViewOrdering,
} from "@repo/app/documents/lib/table-view-pipeline";
import { describe, expect, it } from "vitest";
import {
  branchRow,
  documentRow,
  issueRow,
  projectRow,
  sessionRow,
} from "./root-first-fixtures";

/**
 * ISS-9437 — one mixed artifact table, one order.
 *
 * Six rows drawn from all four status vocabularies this table mixes plus a value
 * in none of them. Both flag branches are asserted in this file, so neither can
 * be read as covered while the other silently changed.
 *
 * A SESSION row's stored status is spelled `ACTIVE` on purpose. `active` would
 * pass through the raw fold unchanged, so a mutation that swapped the session
 * arm to read the raw column would still be green; the uppercase spelling is
 * what makes that arm's normalization observable.
 */
const ROOT_FIRST = rootFirstTableViewOrdering(
  STORED_SESSION_STATUS_ROW_OPTIONS
);

const MIXED_ROWS: DocumentRowItem[] = [
  issueRow("issue-todo", IssueStatus.Todo),
  projectRow("project-not-started", ProjectStatus.NotStarted),
  documentRow("doc-draft", DocumentStatus.Draft),
  sessionRow("session-active", "ACTIVE"),
  branchRow("branch-merged", GitHubPRState.Merged),
  documentRow("doc-garbage", "GARBAGE"),
];

describe("rowArtifactStatus — every row kind folds to its own root", () => {
  it("classifies each row of the mixed table", () => {
    // The ROOTS, not only the resulting order. An order-only assertion passes
    // against a BROKEN branch fold, because `unknown` ties `unknown` under a
    // stable sort and the two rows keep their input positions.
    expect(MIXED_ROWS.map((row) => rowArtifactStatus(row).root)).toEqual([
      ARTIFACT_STATUS_ROOT.Todo,
      ARTIFACT_STATUS_ROOT.Todo,
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_ROOT.Done,
      DISPLAYED_ARTIFACT_STATUS.Unknown,
    ]);
  });

  it("folds a branch row through the PR-state recognizer, not the BranchStatus table", () => {
    // Kills: swapping the branch arm back to `toArtifactStatusFromBranch`. That
    // table is keyed on `BranchStatus` ("merged"), so the raw `MERGED` a branch
    // ROW carries misses it and the row falls to `unknown`.
    expect(rowArtifactStatus(branchRow("b", GitHubPRState.Merged)).root).toBe(
      ARTIFACT_STATUS_ROOT.Done
    );
    expect(rowArtifactStatus(branchRow("b", GitHubPRState.Open)).root).toBe(
      ARTIFACT_STATUS_ROOT.InReview
    );
    expect(rowArtifactStatus(branchRow("b", "WEIRD")).root).toBe(
      DISPLAYED_ARTIFACT_STATUS.Unknown
    );
  });

  it("folds a session row through the same normalization the row renders with", () => {
    // Kills: swapping the session arm to the raw column. `toArtifactStatusFromSession`
    // is keyed on the lowercase display vocabulary, so the stored `ACTIVE` misses
    // it without the fold the registry applies.
    expect(rowArtifactStatus(sessionRow("s", "ACTIVE")).root).toBe(
      ARTIFACT_STATUS_ROOT.InProgress
    );
  });

  it("uses retained Document evidence for champion grouping and ordering", () => {
    const fallbackRow = documentRow(
      "doc-with-future-status",
      DocumentStatus.Draft
    );
    if (fallbackRow.kind !== "document") {
      throw new Error("documentRow returned a non-document fixture");
    }
    const skewedRow: DocumentRowItem = {
      ...fallbackRow,
      data: {
        ...fallbackRow.data,
        rawStatus: "FUTURE_DOCUMENT_STATUS",
      },
    };
    const rows = [
      skewedRow,
      documentRow("doc-executed", DocumentStatus.Executed),
    ];

    expect(rowArtifactStatus(skewedRow).root).toBe(
      DISPLAYED_ARTIFACT_STATUS.Unknown
    );
    expect(sortedIds(rows, "asc", ROOT_FIRST)).toEqual([
      "doc-executed",
      "doc-with-future-status",
    ]);
    expect(
      buildDocumentGridGroups({
        groupBy: GroupByMode.Status,
        isGroupedView: false,
        groups: [],
        flatItems: rows,
        groupOptions: ROOT_FIRST.groupOptions,
      }).map((section) => section.descriptor.key)
    ).toEqual([DocumentStatus.Executed, "FUTURE_DOCUMENT_STATUS"]);
  });
});

describe("Status column order with the root-first ordering ON", () => {
  it("orders by root band ascending, unknown last", () => {
    expect(sortedIds(MIXED_ROWS, "asc", ROOT_FIRST)).toEqual([
      "issue-todo",
      "project-not-started",
      "doc-draft",
      "session-active",
      "branch-merged",
      "doc-garbage",
    ]);
  });

  it("reverses the bands on descending and STILL leaves unknown last", () => {
    expect(sortedIds(MIXED_ROWS, "desc", ROOT_FIRST)).toEqual([
      "branch-merged",
      "doc-draft",
      "session-active",
      "issue-todo",
      "project-not-started",
      "doc-garbage",
    ]);
  });

  it("keeps a raw-rank MISS last INSIDE its band on descending", () => {
    // Both rows fold to `done`, so level 1 ties and the raw rank decides:
    // `EXECUTED` is ranked, `MERGED` is a miss. A level-2 tiebreak that negated
    // its rank rather than parking the miss would float `MERGED` to the TOP of
    // the band here, which is the pre-ISS-9437 Documents behavior.
    const band = [
      branchRow("branch-merged", GitHubPRState.Merged),
      documentRow("doc-executed", DocumentStatus.Executed),
    ];
    expect(sortedIds(band, "desc", ROOT_FIRST)).toEqual([
      "doc-executed",
      "branch-merged",
    ]);
    expect(sortedIds(band, "asc", ROOT_FIRST)).toEqual([
      "doc-executed",
      "branch-merged",
    ]);
  });
});

describe("Status column order with the root-first ordering OFF", () => {
  it("is today's raw-rank order, with unknown ahead of nothing on ascending", () => {
    expect(sortedIds(MIXED_ROWS, "asc", DEFAULT_TABLE_VIEW_ORDERING)).toEqual([
      "doc-draft",
      "issue-todo",
      "project-not-started",
      "session-active",
      "branch-merged",
      "doc-garbage",
    ]);
  });

  it("keeps today's descending quirk, where the unranked rows come FIRST", () => {
    // Not a bug being introduced — this is what the column does on `main`, and
    // flag-OFF must reproduce it. The contrast with the ON case above is the
    // whole point of the ticket.
    expect(sortedIds(MIXED_ROWS, "desc", DEFAULT_TABLE_VIEW_ORDERING)).toEqual([
      "project-not-started",
      "session-active",
      "branch-merged",
      "doc-garbage",
      "issue-todo",
      "doc-draft",
    ]);
  });
});

describe("what the ordering must NOT change", () => {
  it("renders the same rows either way — only their order moves", () => {
    expect([...sortedIds(MIXED_ROWS, "asc", ROOT_FIRST)].sort()).toEqual(
      [...sortedIds(MIXED_ROWS, "asc", DEFAULT_TABLE_VIEW_ORDERING)].sort()
    );
  });

  it("changes only the Session header to the display status the champion renders", () => {
    const off = sectionLabels(DEFAULT_TABLE_VIEW_ORDERING);
    const on = sectionLabels(ROOT_FIRST);
    expect([...off].sort()).toEqual([
      "ACTIVE=ACTIVE",
      "DRAFT=Draft",
      "GARBAGE=GARBAGE",
      "MERGED=MERGED",
      "NOT_STARTED=NOT_STARTED",
      "TODO=Todo",
    ]);
    expect([...on].sort()).toEqual([
      "DRAFT=Draft",
      "GARBAGE=GARBAGE",
      "MERGED=MERGED",
      "NOT_STARTED=NOT_STARTED",
      "TODO=Todo",
      "active=active",
    ]);
  });
});

function sortedIds(
  rows: DocumentRowItem[],
  direction: "asc" | "desc",
  ordering: typeof DEFAULT_TABLE_VIEW_ORDERING
): string[] {
  return buildFlatItems(
    rows,
    undefined,
    SortKey.Status,
    direction,
    ordering
  ).map((item) => item.data.id);
}

function sectionLabels(ordering: typeof DEFAULT_TABLE_VIEW_ORDERING): string[] {
  return buildDocumentGridGroups({
    groupBy: GroupByMode.Status,
    isGroupedView: false,
    groups: [],
    flatItems: MIXED_ROWS,
    groupOptions: ordering.groupOptions,
  }).map((section) => `${section.descriptor.key}=${section.descriptor.label}`);
}
