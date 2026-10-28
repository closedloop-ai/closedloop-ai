import { Priority } from "@repo/api/src/types/common";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";

export function makeFilterItem(
  id: string,
  options: {
    assigneeId?: string | null;
    createdAt?: Date;
    priority?: Priority | null;
    tagIds?: string[];
    updatedAt?: Date;
  } = {}
): DocumentRowItem {
  return {
    kind: "document",
    data: {
      id,
      title: `Item ${id}`,
      type: DocumentType.Prd,
      slug: `item-${id}`,
      status: DocumentStatus.Draft,
      priority:
        options.priority === undefined ? Priority.Medium : options.priority,
      assigneeId: options.assigneeId ?? null,
      assignee: null,
      createdAt: options.createdAt ?? new Date(),
      updatedAt: options.updatedAt ?? new Date(),
      tags: (options.tagIds ?? []).map((tagId) => ({ id: tagId })),
    } as unknown as DocumentWithProject,
  };
}
