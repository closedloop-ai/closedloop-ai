import { Priority } from "@repo/api/src/types/common";
import {
  type Document,
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document";

export function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc-1",
    organizationId: "org-1",
    projectId: null,
    type: DocumentType.Prd,
    title: "Document",
    slug: "document",
    fileName: null,
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    latestVersion: 1,
    createdById: "user-1",
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    repositorySnapshot: { repositories: [], source: SnapshotSource.None },
    templateForType: null,
    sortOrder: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
