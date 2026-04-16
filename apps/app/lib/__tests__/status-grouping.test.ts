import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import { describe, expect, test } from "vitest";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { DOCUMENT_STATUS_LABELS } from "@/lib/project-constants";
import { groupItemsByStatus, STATUS_DISPLAY_ORDER } from "../status-grouping";

function makeItem(id: string, status: DocumentStatus): DocumentRowItem {
  return {
    kind: "artifact",
    data: {
      id,
      status,
      title: `Artifact ${id}`,
      type: "PRD",
      slug: `art-${id}`,
    } as DocumentWithWorkstream,
  };
}

describe("STATUS_DISPLAY_ORDER", () => {
  test("contains every DocumentStatus value exactly once", () => {
    const allStatuses = Object.values(DocumentStatus);
    expect(STATUS_DISPLAY_ORDER).toHaveLength(allStatuses.length);
    for (const status of allStatuses) {
      expect(STATUS_DISPLAY_ORDER).toContain(status);
    }
  });
});

describe("groupItemsByStatus", () => {
  test("returns empty array for empty input", () => {
    expect(groupItemsByStatus([])).toEqual([]);
  });

  test("groups a single item into one section", () => {
    const items = [makeItem("1", DocumentStatus.Draft)];
    const sections = groupItemsByStatus(items);

    expect(sections).toHaveLength(1);
    expect(sections[0].status).toBe(DocumentStatus.Draft);
    expect(sections[0].label).toBe(
      DOCUMENT_STATUS_LABELS[DocumentStatus.Draft]
    );
    expect(sections[0].items).toHaveLength(1);
    expect(sections[0].items[0].data.id).toBe("1");
  });

  test("groups multiple items with the same status together", () => {
    const items = [
      makeItem("1", DocumentStatus.InProgress),
      makeItem("2", DocumentStatus.InProgress),
      makeItem("3", DocumentStatus.InProgress),
    ];
    const sections = groupItemsByStatus(items);

    expect(sections).toHaveLength(1);
    expect(sections[0].items).toHaveLength(3);
  });

  test("omits statuses with no items", () => {
    const items = [
      makeItem("1", DocumentStatus.Draft),
      makeItem("2", DocumentStatus.Done),
    ];
    const sections = groupItemsByStatus(items);

    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.status)).toEqual([
      DocumentStatus.Draft,
      DocumentStatus.Done,
    ]);
  });

  test("orders sections by STATUS_DISPLAY_ORDER regardless of input order", () => {
    const items = [
      makeItem("1", DocumentStatus.Done),
      makeItem("2", DocumentStatus.Draft),
      makeItem("3", DocumentStatus.InReview),
    ];
    const sections = groupItemsByStatus(items);
    const sectionStatuses = sections.map((s) => s.status);

    expect(sectionStatuses).toEqual([
      DocumentStatus.Draft,
      DocumentStatus.InReview,
      DocumentStatus.Done,
    ]);
  });

  test("preserves item order within each section", () => {
    const items = [
      makeItem("a", DocumentStatus.Draft),
      makeItem("b", DocumentStatus.Draft),
      makeItem("c", DocumentStatus.Draft),
    ];
    const sections = groupItemsByStatus(items);
    const ids = sections[0].items.map((i) => i.data.id);

    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("each section has the correct label from DOCUMENT_STATUS_LABELS", () => {
    const items = [
      makeItem("1", DocumentStatus.Draft),
      makeItem("2", DocumentStatus.InProgress),
      makeItem("3", DocumentStatus.Approved),
    ];
    const sections = groupItemsByStatus(items);

    for (const section of sections) {
      expect(section.label).toBe(DOCUMENT_STATUS_LABELS[section.status]);
    }
  });
});
