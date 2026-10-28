import { Priority } from "@repo/api/src/types/common";
import { DocumentType, SnapshotSource } from "@repo/api/src/types/document";
import type { Mock } from "vitest";

/**
 * The single-document write fixtures shared by the `documentStatusMutationService`
 * suites. Each suite hoists its own mocks (a `vi.mock` factory is per file) and
 * hands them to {@link makeTx}.
 */

export const ORG_ID = "00000000-0000-0000-0000-000000000010";
export const DOC_ID = "00000000-0000-0000-0000-000000000011";
const PROJECT_ID = "00000000-0000-0000-0000-000000000013";
const DATE = new Date("2026-09-10T12:00:00Z");

export type TxMocks = {
  artifactFindUnique: Mock;
  artifactUpdate: Mock;
  artifactUpdateMany: Mock;
  projectFindUnique: Mock;
  queryRaw: Mock;
  userFindFirst: Mock;
};

export function makeTx(mocks: TxMocks) {
  return {
    $queryRaw: mocks.queryRaw,
    artifact: {
      findUnique: mocks.artifactFindUnique,
      update: mocks.artifactUpdate,
      updateMany: mocks.artifactUpdateMany,
    },
    project: { findUnique: mocks.projectFindUnique },
    user: { findFirst: mocks.userFindFirst },
  };
}

export function artifactRow({
  name = "Ticket",
  status,
  subtype = DocumentType.Feature,
  priority = Priority.Medium,
  assigneeId = null,
}: {
  name?: string;
  status: string;
  subtype?: DocumentType;
  priority?: Priority | null;
  assigneeId?: string | null;
}) {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    name,
    slug: "ISS-9433",
    status,
    priority,
    dueDate: null,
    sortOrder: null,
    subtype,
    createdAt: DATE,
    createdById: null,
    updatedAt: DATE,
    assigneeId,
    assignee: null,
    createdBy: null,
    document: {
      fileName: null,
      latestVersion: 1,
      approverId: null,
      approver: null,
      repositorySnapshot: {
        repositories: [],
        source: SnapshotSource.None,
      },
      templateForType: null,
    },
  };
}
