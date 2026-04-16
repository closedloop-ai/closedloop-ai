import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { describe, expect, test } from "vitest";
import type { ArtifactRowItem } from "@/components/artifact-table/artifact-row";
import { ARTIFACT_STATUS_LABELS } from "@/lib/project-constants";
import { groupItemsByStatus, STATUS_DISPLAY_ORDER } from "../status-grouping";

function makeItem(id: string, status: ArtifactStatus): ArtifactRowItem {
  return {
    kind: "artifact",
    data: {
      id,
      status,
      title: `Artifact ${id}`,
      type: "PRD",
      slug: `art-${id}`,
    } as ArtifactWithWorkstream,
  };
}

describe("STATUS_DISPLAY_ORDER", () => {
  test("contains every ArtifactStatus value exactly once", () => {
    const allStatuses = Object.values(ArtifactStatus);
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
    const items = [makeItem("1", ArtifactStatus.Draft)];
    const sections = groupItemsByStatus(items);

    expect(sections).toHaveLength(1);
    expect(sections[0].status).toBe(ArtifactStatus.Draft);
    expect(sections[0].label).toBe(
      ARTIFACT_STATUS_LABELS[ArtifactStatus.Draft]
    );
    expect(sections[0].items).toHaveLength(1);
    expect(sections[0].items[0].data.id).toBe("1");
  });

  test("groups multiple items with the same status together", () => {
    const items = [
      makeItem("1", ArtifactStatus.InProgress),
      makeItem("2", ArtifactStatus.InProgress),
      makeItem("3", ArtifactStatus.InProgress),
    ];
    const sections = groupItemsByStatus(items);

    expect(sections).toHaveLength(1);
    expect(sections[0].items).toHaveLength(3);
  });

  test("omits statuses with no items", () => {
    const items = [
      makeItem("1", ArtifactStatus.Draft),
      makeItem("2", ArtifactStatus.Done),
    ];
    const sections = groupItemsByStatus(items);

    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.status)).toEqual([
      ArtifactStatus.Draft,
      ArtifactStatus.Done,
    ]);
  });

  test("orders sections by STATUS_DISPLAY_ORDER regardless of input order", () => {
    const items = [
      makeItem("1", ArtifactStatus.Done),
      makeItem("2", ArtifactStatus.Draft),
      makeItem("3", ArtifactStatus.InReview),
    ];
    const sections = groupItemsByStatus(items);
    const sectionStatuses = sections.map((s) => s.status);

    expect(sectionStatuses).toEqual([
      ArtifactStatus.Draft,
      ArtifactStatus.InReview,
      ArtifactStatus.Done,
    ]);
  });

  test("preserves item order within each section", () => {
    const items = [
      makeItem("a", ArtifactStatus.Draft),
      makeItem("b", ArtifactStatus.Draft),
      makeItem("c", ArtifactStatus.Draft),
    ];
    const sections = groupItemsByStatus(items);
    const ids = sections[0].items.map((i) => i.data.id);

    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("each section has the correct label from ARTIFACT_STATUS_LABELS", () => {
    const items = [
      makeItem("1", ArtifactStatus.Draft),
      makeItem("2", ArtifactStatus.InProgress),
      makeItem("3", ArtifactStatus.Approved),
    ];
    const sections = groupItemsByStatus(items);

    for (const section of sections) {
      expect(section.label).toBe(ARTIFACT_STATUS_LABELS[section.status]);
    }
  });
});
