import { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import {
  buildExtensionFilterGroups,
  buildFilterViewModel,
  matchesExtensionFilters,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { PRIORITY_LABELS } from "@repo/design-system/lib/priority-order";
import { describe, expect, it, vi } from "vitest";
import {
  documentToPrototypeListRow,
  issuesPrototypeColumns,
  productionSortColumn,
  prototypeSortColumn,
} from "../artifact-list-model";

const rows = ["project-a", "project-b"].map((projectId, index) =>
  documentToPrototypeListRow(
    createMockDocument({
      id: `issue-${index}`,
      type: DocumentType.Feature,
      projectId,
      project: {
        id: projectId,
        name: "Delivery",
        teams: [{ id: "team-1", name: "Engineering" }],
      },
      tags: [{ id: `tag-${index}`, name: "Review", color: TagColor.Blue }],
    }),
    Date.now()
  )
);

describe("production artifact facets", () => {
  it("keeps production and shared sort keys paired", () => {
    for (const [production, shared] of [
      ["title", "name"],
      ["assignee", "owner"],
      ["type", "document-type"],
      ["updated", "updated"],
    ]) {
      expect(prototypeSortColumn(production)).toBe(shared);
      expect(productionSortColumn(shared)).toBe(production);
    }
  });

  it("retains distinct project identities with duplicate display names", () => {
    const columns = issuesPrototypeColumns();
    const project = columns.find((column) => column.id === "project");
    expect(project?.groupValue?.(rows[0])).toBe("project-a");
    expect(project?.groupValue?.(rows[1])).toBe("project-b");
    expect(project?.valueLabel?.("project-a", rows)).toBe("Delivery");
    const group = buildExtensionFilterGroups(columns, rows, {}, vi.fn()).find(
      (group) => group.id === "project"
    );
    expect(group).toMatchObject({
      options: [
        { id: "project-a", label: "Delivery" },
        { id: "project-b", label: "Delivery" },
      ],
    });
    expect(
      matchesExtensionFilters(rows[0], columns, {
        project: { selectedValues: ["project-a"] },
      })
    ).toBe(true);
    expect(
      matchesExtensionFilters(rows[1], columns, {
        project: { selectedValues: ["project-a"] },
      })
    ).toBe(false);
  });
  it("labels priority groups and facets through the canonical priority labels", () => {
    const prioritized = [Priority.Medium, Priority.Urgent].map(
      (priority, index) =>
        documentToPrototypeListRow(
          createMockDocument({
            id: `prioritized-${index}`,
            type: DocumentType.Feature,
            priority,
          }),
          Date.now()
        )
    );
    const columns = issuesPrototypeColumns();
    const column = columns.find((candidate) => candidate.id === "priority");
    expect(column?.groupValue?.(prioritized[0])).toBe(Priority.Medium);
    expect(column?.valueLabel?.(Priority.Medium, prioritized)).toBe(
      PRIORITY_LABELS.MEDIUM
    );
    const group = buildExtensionFilterGroups(
      columns,
      prioritized,
      {},
      vi.fn()
    ).find((candidate) => candidate.id === "priority");
    expect(group).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({
          id: Priority.Medium,
          label: PRIORITY_LABELS.MEDIUM,
        }),
        expect.objectContaining({
          id: Priority.Urgent,
          label: PRIORITY_LABELS.URGENT,
        }),
      ]),
    });
  });
  it("offers tag IDs while displaying tag names", () => {
    expect(rows[0].tagIds).toEqual(["tag-0"]);
    expect(buildFilterViewModel(rows).tagOptions).toEqual([
      { id: "tag-0", label: "Review" },
      { id: "tag-1", label: "Review" },
    ]);
  });
});
