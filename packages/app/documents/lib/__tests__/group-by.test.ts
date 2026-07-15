import { Priority } from "@repo/api/src/types/common";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  GROUP_BY_LABELS,
  GroupByMode,
  groupByMode,
} from "@repo/app/documents/lib/group-by";
import { describe, expect, test } from "vitest";

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
        status: FeatureStatus.InProgress,
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
});

describe("groupByMode — priority", () => {
  test("orders sections Urgent → High → Medium → Low → No priority", () => {
    const items = [
      makeItem("low", { priority: Priority.Low }),
      makeItem("none", { priority: null }),
      makeItem("urgent", { priority: Priority.Urgent }),
      makeItem("medium", { priority: Priority.Medium }),
      makeItem("high", { priority: Priority.High }),
    ];
    const sections = groupByMode(items, identity, GroupByMode.Priority);

    expect(sections.map((s) => s.descriptor.key)).toEqual([
      Priority.Urgent,
      Priority.High,
      Priority.Medium,
      Priority.Low,
      "no-priority",
    ]);
  });

  test("null-priority section has the expected label", () => {
    const items = [makeItem("1", { priority: null })];
    const [section] = groupByMode(items, identity, GroupByMode.Priority);

    expect(section.descriptor.label).toBe("No priority");
    expect(section.descriptor.priority).toBeNull();
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
