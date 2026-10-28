import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureFieldEditAnalytics: vi.fn(),
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: vi.fn(),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: (...args: unknown[]) =>
    mocks.captureFieldEditAnalytics(...args),
}));
vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: { updateAssigneeManyAfterCommit: vi.fn() },
}));
vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: vi.fn(),
  },
}));

import { emitBulkAssignSideEffects } from "@/app/agent-sessions/bulk-assign-side-effects";
import { AgentSessionBulkAssignField } from "@/app/agent-sessions/write-contract";
import { emitBatchPrioritySideEffects } from "@/app/documents/batch-priority-side-effects";
import { emitBatchStatusSideEffects } from "@/app/documents/batch-status-side-effects";
import { emitBatchTagSideEffects } from "@/app/tags/batch-tag-side-effects";
import { emitBatchMoveSideEffects } from "@/lib/batch-move-side-effects";

const USER = { id: "user-1", organizationId: "org-1" };
const AUTH = "session" as const;
const TXN = "11111111-1111-4111-8111-111111111111";
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("field-edit analytics across bulk adapters", () => {
  it("emits one grouped aggregate for every bulk field adapter", async () => {
    emitBatchMoveSideEffects({
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
      surface: ArtifactStatusEditSurface.Bulk,
    });
    emitBatchTagSideEffects({
      user: USER,
      authMethod: AUTH,
      tagId: "tag-1",
      action: AuditAction.ArtifactTagApplied,
      changedIds: [ROW_A, ROW_B],
      transactionId: TXN,
    });
    emitBulkAssignSideEffects({
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Owner,
      changes: [{ artifactId: ROW_A, before: null, after: "user-9" }],
      transactionId: TXN,
    });
    emitBatchPrioritySideEffects({
      user: USER,
      authMethod: AUTH,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.Bulk,
      changedIds: [ROW_A],
      beforePriorities: new Map([[ROW_A, Priority.Low]]),
      transactionId: TXN,
    });
    await emitBatchStatusSideEffects({
      user: USER,
      authMethod: AUTH,
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Bulk,
      transitions: [
        {
          documentId: ROW_A,
          before: IssueStatus.Todo,
          after: IssueStatus.Done,
        },
      ],
      changedIds: [ROW_A],
      transactionId: TXN,
    });

    expect(mocks.captureFieldEditAnalytics.mock.calls).toEqual([
      [
        expect.objectContaining({
          field: ArtifactFieldEditField.ProjectId,
          artifactCount: 1,
          commitGroupId: TXN,
          provenance: {
            surface: ArtifactStatusEditSurface.Bulk,
            commitGroupId: TXN,
          },
        }),
      ],
      [
        expect.objectContaining({
          field: ArtifactFieldEditField.Tag,
          artifactCount: 2,
          commitGroupId: TXN,
          provenance: {
            surface: ArtifactStatusEditSurface.Bulk,
            commitGroupId: TXN,
          },
        }),
      ],
      [
        expect.objectContaining({
          field: ArtifactFieldEditField.AssigneeId,
          artifactCount: 1,
          commitGroupId: TXN,
          provenance: {
            surface: ArtifactStatusEditSurface.Bulk,
            commitGroupId: TXN,
          },
        }),
      ],
      [
        expect.objectContaining({
          field: ArtifactFieldEditField.Priority,
          artifactCount: 1,
          commitGroupId: TXN,
          provenance: {
            surface: ArtifactStatusEditSurface.Bulk,
            commitGroupId: TXN,
          },
        }),
      ],
      [
        expect.objectContaining({
          field: ArtifactFieldEditField.Status,
          artifactCount: 1,
          commitGroupId: TXN,
          provenance: {
            surface: ArtifactStatusEditSurface.Bulk,
            commitGroupId: TXN,
          },
        }),
      ],
    ]);
  });

  it("retains grouped lineage but omits UI surface for API-key writes", async () => {
    const authMethod = "api_key" as const;
    emitBatchMoveSideEffects({
      user: USER,
      authMethod,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
      surface: ArtifactStatusEditSurface.Bulk,
    });
    emitBatchTagSideEffects({
      user: USER,
      authMethod,
      tagId: "tag-1",
      action: AuditAction.ArtifactTagApplied,
      changedIds: [ROW_A],
      transactionId: TXN,
    });
    emitBulkAssignSideEffects({
      user: USER,
      authMethod,
      field: AgentSessionBulkAssignField.Owner,
      changes: [{ artifactId: ROW_A, before: null, after: "user-9" }],
      transactionId: TXN,
    });
    emitBatchPrioritySideEffects({
      user: USER,
      authMethod,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.Bulk,
      changedIds: [ROW_A],
      beforePriorities: new Map([[ROW_A, Priority.Low]]),
      transactionId: TXN,
    });
    await emitBatchStatusSideEffects({
      user: USER,
      authMethod,
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Bulk,
      transitions: [
        {
          documentId: ROW_A,
          before: IssueStatus.Todo,
          after: IssueStatus.Done,
        },
      ],
      changedIds: [ROW_A],
      transactionId: TXN,
    });

    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledTimes(5);
    for (const [analytics] of mocks.captureFieldEditAnalytics.mock.calls) {
      expect(analytics).toEqual(
        expect.objectContaining({ commitGroupId: TXN })
      );
      expect(analytics).not.toHaveProperty("provenance");
      expect(analytics).not.toHaveProperty("surface");
    }
  });

  it("omits an unknown artifact count for a tag retry that changes no rows", () => {
    emitBatchTagSideEffects({
      user: USER,
      authMethod: AUTH,
      tagId: "tag-1",
      action: AuditAction.ArtifactTagApplied,
      changedIds: [],
      transactionId: TXN,
    });

    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: USER.organizationId,
      userId: USER.id,
      field: ArtifactFieldEditField.Tag,
      result: ArtifactFieldEditOutcome.NoChange,
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TXN,
      },
      before: null,
      after: "tag-1",
      commitGroupId: TXN,
    });
  });

  it("reports the exact moved-row count for a batch-move no-op", () => {
    emitBatchMoveSideEffects({
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-2", after: "proj-2" },
      ],
      transactionId: TXN,
      surface: ArtifactStatusEditSurface.Bulk,
    });

    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: USER.organizationId,
      userId: USER.id,
      field: ArtifactFieldEditField.ProjectId,
      result: ArtifactFieldEditOutcome.NoChange,
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TXN,
      },
      after: "proj-2",
      artifactCount: 0,
      commitGroupId: TXN,
    });
  });

  it("omits provenance when a batch-move surface is unknown", () => {
    emitBatchMoveSideEffects({
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
      surface: undefined,
    });

    const [analytics] = mocks.captureFieldEditAnalytics.mock.calls[0];
    expect(analytics).not.toHaveProperty("provenance");
    expect(analytics).not.toHaveProperty("surface");
  });

  it("preserves undo lineage on the status aggregate", async () => {
    const undoOfTransactionId = "22222222-2222-4222-8222-222222222222";
    await emitBatchStatusSideEffects({
      user: USER,
      authMethod: AUTH,
      status: IssueStatus.Todo,
      surface: ArtifactStatusEditSurface.Bulk,
      transitions: [
        {
          documentId: ROW_A,
          before: IssueStatus.Done,
          after: IssueStatus.Todo,
        },
      ],
      changedIds: [ROW_A],
      transactionId: TXN,
      undoOfTransactionId,
    });

    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Status,
        commitGroupId: TXN,
        provenance: {
          surface: ArtifactStatusEditSurface.Bulk,
          commitGroupId: TXN,
        },
        undoOfCommitGroupId: undoOfTransactionId,
      })
    );
  });
});
