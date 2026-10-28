import { ARTIFACT_STATUS_UNKNOWN_LABEL } from "@repo/api/src/types/artifact-status-display";
import { Priority } from "@repo/api/src/types/common";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { BasicUser } from "@repo/api/src/types/user";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  GROUP_BY_LABELS,
  GroupByMode,
  type GroupByModeOptions,
  type GroupByNonNone,
  groupByMode,
} from "@repo/app/documents/lib/group-by";
import { STORED_SESSION_STATUS_ROW_OPTIONS } from "@repo/app/documents/lib/row-artifact-status";
import { rootFirstTableViewOrdering } from "@repo/app/documents/lib/table-view-pipeline";
import { describe, expect, test } from "vitest";
import { branchRow, projectRow, sessionRow } from "./root-first-fixtures";

function makeItem(
  id: string,
  overrides: {
    status?: DocumentStatus;
    priority?: Priority | null;
    assignee?: BasicUser | null;
  } = {}
): DocumentRowItem {
  return {
    kind: "document",
    data: {
      id,
      status: overrides.status ?? DocumentStatus.Draft,
      priority: overrides.priority ?? null,
      assignee: overrides.assignee ?? null,
      title: `Artifact ${id}`,
      type: DocumentType.Prd,
      slug: `art-${id}`,
    } as DocumentWithProject,
  };
}

function makeUser(id: string, firstName: string, lastName: string): BasicUser {
  return {
    id,
    email: `${id}@example.com`,
    firstName,
    lastName,
    avatarUrl: null,
  };
}

const identity = (item: DocumentRowItem) => item;
const UNKNOWN_PRIORITY = "BLOCKER";
const COLLIDING_UNKNOWN_PRIORITY = "no-priority";

describe("groupByMode — status", () => {
  test("returns empty array for empty input", () => {
    expect(groupByMode([], identity, GroupByMode.Status)).toEqual([]);
  });

  test("orders sections by STATUS enum order regardless of input order", () => {
    const items = [
      makeItem("1", { status: DocumentStatus.Approved }),
      makeItem("2", { status: DocumentStatus.Draft }),
      makeItem("3", { status: DocumentStatus.InReview }),
    ];
    const sections = groupByMode(items, identity, GroupByMode.Status);

    expect(sections.map((s) => s.descriptor.status)).toEqual([
      DocumentStatus.Draft,
      DocumentStatus.InReview,
      DocumentStatus.Approved,
    ]);
  });

  test("buckets items of the same status together preserving insertion order", () => {
    const items = [
      makeItem("a", { status: DocumentStatus.Draft }),
      makeItem("b", { status: DocumentStatus.Draft }),
      makeItem("c", { status: DocumentStatus.Draft }),
    ];
    const [section] = groupByMode(items, identity, GroupByMode.Status);

    expect(section.values.map((v) => v.data.id)).toEqual(["a", "b", "c"]);
  });

  test("labels headers in title case from the combined vocabulary and carries the artifact type", () => {
    const featureItem: DocumentRowItem = {
      kind: "document",
      data: {
        id: "f",
        status: IssueStatus.InProgress,
        priority: null,
        assignee: null,
        title: "Feature",
        type: DocumentType.Feature,
        slug: "FEA-1",
      } as unknown as DocumentWithProject,
    };
    const [section] = groupByMode([featureItem], identity, GroupByMode.Status);

    // "IN_PROGRESS" → "In Progress", not the raw enum value.
    expect(section.descriptor.label).toBe("In Progress");
    expect(section.descriptor.artifactType).toBe(DocumentType.Feature);
  });

  test("keeps explicit null status evidence in an Unknown band", () => {
    const [section] = groupByMode(
      [makeItem("missing-status")],
      identity,
      GroupByMode.Status,
      { statusEvidence: () => null }
    );

    expect(section.descriptor.status).toBeNull();
    expect(section.descriptor.label).toBe(ARTIFACT_STATUS_UNKNOWN_LABEL);
    expect(section.descriptor.label).not.toBe("Draft");
  });
});

describe("groupByMode — priority", () => {
  test("orders sections Urgent → High → Medium → Low → unknown → No priority", () => {
    const items = [
      makeItem("unknown", { priority: UNKNOWN_PRIORITY as Priority }),
      makeItem("low", { priority: Priority.Low }),
      makeItem("none", { priority: null }),
      makeItem("urgent", { priority: Priority.Urgent }),
      makeItem("medium", { priority: Priority.Medium }),
      makeItem("high", { priority: Priority.High }),
    ];
    const sections = groupByMode(items, identity, GroupByMode.Priority);

    expect(sections.map((s) => s.descriptor.label)).toEqual([
      "Urgent",
      "High",
      "Medium",
      "Low",
      "Unknown priority",
      "No priority",
    ]);
  });

  test.each<
    [
      priority: Priority | null,
      expectedLabel: string,
      expectedPriority: Priority | null,
    ]
  >([
    [Priority.Urgent, "Urgent", Priority.Urgent],
    [Priority.High, "High", Priority.High],
    [Priority.Medium, "Medium", Priority.Medium],
    [Priority.Low, "Low", Priority.Low],
    [null, "No priority", null],
    [UNKNOWN_PRIORITY as Priority, "Unknown priority", null],
  ])(
    "priority %s section has label %s",
    (priority, expectedLabel, expectedPriority) => {
      const items = [makeItem("1", { priority })];
      const [section] = groupByMode(items, identity, GroupByMode.Priority);

      expect(section.descriptor.label).toBe(expectedLabel);
      expect(section.descriptor.priority).toBe(expectedPriority);
      expect(section.descriptor.isUnknownPriority).toBe(
        priority !== null && expectedPriority === null
      );
    }
  );

  test("orders unknown and no-priority sections consistently in either input order", () => {
    const forward = sectionKeys(
      [
        makeItem("unknown", { priority: UNKNOWN_PRIORITY as Priority }),
        makeItem("none", { priority: null }),
      ],
      {},
      GroupByMode.Priority
    );
    const reversed = sectionKeys(
      [
        makeItem("none", { priority: null }),
        makeItem("unknown", { priority: UNKNOWN_PRIORITY as Priority }),
      ],
      {},
      GroupByMode.Priority
    );

    expect(prioritySectionLabels(forward)).toEqual([
      "Unknown priority",
      "No priority",
    ]);
    expect(prioritySectionLabels(reversed)).toEqual(
      prioritySectionLabels(forward)
    );
    expect(reversed).toEqual(forward);
  });

  test("keeps a no-priority unknown token out of the real null priority bucket", () => {
    const [unknownSection, emptySection] = groupByMode(
      [
        makeItem("unknown", {
          priority: COLLIDING_UNKNOWN_PRIORITY as Priority,
        }),
        makeItem("none", { priority: null }),
      ],
      identity,
      GroupByMode.Priority
    );

    expect(unknownSection.descriptor.key).not.toBe(emptySection.descriptor.key);
    expect(unknownSection.descriptor.label).toBe("Unknown priority");
    expect(unknownSection.descriptor.isUnknownPriority).toBe(true);
    expect(unknownSection.values.map((value) => value.data.id)).toEqual([
      "unknown",
    ]);
    expect(emptySection.descriptor.label).toBe("No priority");
    expect(emptySection.descriptor.isUnknownPriority).toBe(false);
    expect(emptySection.values.map((value) => value.data.id)).toEqual(["none"]);
  });
});

describe("groupByMode — assignee", () => {
  test("groups by assignee id and sorts alphabetically by display name", () => {
    const alice = makeUser("u1", "Alice", "Adams");
    const bob = makeUser("u2", "Bob", "Brown");
    const items = [
      makeItem("1", { assignee: bob }),
      makeItem("2", { assignee: alice }),
      makeItem("3", { assignee: bob }),
    ];
    const sections = groupByMode(items, identity, GroupByMode.Assignee);

    expect(sections.map((s) => s.descriptor.key)).toEqual(["u1", "u2"]);
    expect(sections[1].values.map((v) => v.data.id)).toEqual(["1", "3"]);
  });

  test("unassigned items go into a trailing Unassigned section", () => {
    const alice = makeUser("u1", "Alice", "Adams");
    const items = [
      makeItem("1", { assignee: null }),
      makeItem("2", { assignee: alice }),
    ];
    const sections = groupByMode(items, identity, GroupByMode.Assignee);

    expect(sections.map((s) => s.descriptor.key)).toEqual(["u1", "unassigned"]);
    expect(sections[1].descriptor.label).toBe("Unassigned");
    expect(sections[1].descriptor.assignee).toBeNull();
  });
});

describe("groupByMode — getRow", () => {
  test("uses the extractor to bucket wrapper values", () => {
    type Wrapped = { id: string; item: DocumentRowItem };
    const items: Wrapped[] = [
      { id: "w1", item: makeItem("a", { status: DocumentStatus.Draft }) },
      { id: "w2", item: makeItem("b", { status: DocumentStatus.Approved }) },
      { id: "w3", item: makeItem("c", { status: DocumentStatus.Draft }) },
    ];
    const sections = groupByMode(items, (w) => w.item, GroupByMode.Status);

    expect(sections).toHaveLength(2);
    expect(sections[0].values.map((v) => v.id)).toEqual(["w1", "w3"]);
    expect(sections[1].values.map((v) => v.id)).toEqual(["w2"]);
  });
});

describe("GROUP_BY_LABELS", () => {
  test("exposes user-facing labels for every mode", () => {
    expect(GROUP_BY_LABELS).toEqual({
      [GroupByMode.None]: "None",
      [GroupByMode.Status]: "Status",
      [GroupByMode.Assignee]: "Assignee",
      [GroupByMode.Priority]: "Priority",
    });
  });
});

/**
 * ISS-9437 — status section order must be TOTAL, so the headers a reader sees do
 * not depend on which row the API happened to return first.
 *
 * Every pair below shares a root AND is a `statusDisplayRank` miss on BOTH
 * sides, which is the only shape that exercises the third tiebreak: a pair with
 * distinct display ranks (Approved vs Executed) is separated at level 2 and
 * would pass this file without the fix.
 */
const ROOT_FIRST_GROUP_OPTIONS = rootFirstTableViewOrdering(
  STORED_SESSION_STATUS_ROW_OPTIONS
).groupOptions;

const TYING_SECTION_PAIRS: Array<{
  name: string;
  rows: [DocumentRowItem, DocumentRowItem];
  expected: [string, string];
}> = [
  {
    name: "branch MERGED vs session inactive (both done)",
    rows: [
      branchRow("branch-merged", GitHubPRState.Merged),
      sessionRow("session-inactive", "inactive"),
    ],
    expected: ["MERGED", "inactive"],
  },
  {
    name: "project COMPLETED vs ARCHIVED (both done)",
    rows: [
      projectRow("project-completed", ProjectStatus.Completed),
      projectRow("project-archived", ProjectStatus.Archived),
    ],
    expected: ["ARCHIVED", "COMPLETED"],
  },
];

describe("groupByMode — root-first status sections are insertion-order independent", () => {
  for (const pair of TYING_SECTION_PAIRS) {
    test(`${pair.name} orders the same whichever row arrives first`, () => {
      const forward = sectionKeys(pair.rows, ROOT_FIRST_GROUP_OPTIONS);
      const reversed = sectionKeys(
        [pair.rows[1], pair.rows[0]],
        ROOT_FIRST_GROUP_OPTIONS
      );
      expect(forward).toEqual(pair.expected);
      expect(reversed).toEqual(pair.expected);
    });

    test(`${pair.name} really does tie without the descriptor-key tiebreak`, () => {
      // The counterfactual. With no root resolver the sections fall back to the
      // raw display rank alone, both sides miss it, and `Array#sort`'s stability
      // hands the answer to whichever row arrived first — which is exactly the
      // defect the third level removes. If this stopped being true, the case
      // above would be passing for a reason unrelated to the fix.
      const forward = sectionKeys(pair.rows, {});
      const reversed = sectionKeys([pair.rows[1], pair.rows[0]], {});
      expect(forward).not.toEqual(reversed);
    });
  }

  /*
   * ISS-10364 (operator ruling, 2026-09-23/24) retired `waiting` as a distinct
   * displayed session status: "Unparsable status are already converted to
   * Active on import. Don't distinguish between active and stale", then "let's
   * drop waiting as well." A raw `WAITING` row and a raw `ACTIVE` row used to
   * tie on root and need the descriptor-key tiebreak to land in two ordered
   * sections — that pair is gone from `TYING_SECTION_PAIRS` above because they
   * no longer tie at all: both now resolve to the SAME "active" section. This
   * pins the merge as a counterfactual rather than silently dropping the case.
   */
  test("ISS-10364: a legacy WAITING row merges into the same section as ACTIVE, not its own", () => {
    expect(
      sectionKeys(
        [
          sessionRow("session-active", "ACTIVE"),
          sessionRow("session-waiting", "WAITING"),
        ],
        ROOT_FIRST_GROUP_OPTIONS
      )
    ).toEqual(["active"]);
  });

  test("orders the bands by root BEFORE it reaches the tiebreak", () => {
    // A `todo` section sorts ahead of a `done` one even though both raw statuses
    // are misses and the `done` key sorts FIRST by code unit — so the key can
    // only be reading as the third level, never the first.
    expect(
      sectionKeys(
        [
          branchRow("branch-merged", GitHubPRState.Merged),
          projectRow("project-not-started", ProjectStatus.NotStarted),
        ],
        ROOT_FIRST_GROUP_OPTIONS
      )
    ).toEqual(["NOT_STARTED", "MERGED"]);
  });
});

function sectionKeys(
  rows: DocumentRowItem[],
  options: GroupByModeOptions,
  mode: GroupByNonNone = GroupByMode.Status
): string[] {
  return groupByMode(rows, identity, mode, options).map(
    (section) => section.descriptor.key
  );
}

function prioritySectionLabels(keys: string[]): string[] {
  const labelsByKey = new Map(
    groupByMode(
      [
        makeItem("unknown", { priority: UNKNOWN_PRIORITY as Priority }),
        makeItem("none", { priority: null }),
      ],
      identity,
      GroupByMode.Priority
    ).map((section) => [section.descriptor.key, section.descriptor.label])
  );
  return keys.map((key) => labelsByKey.get(key) ?? key);
}
