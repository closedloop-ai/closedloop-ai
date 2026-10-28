import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import {
  ArtifactPriorityMutationErrorCode,
  stalePriorityConflict,
} from "@repo/api/src/types/artifact-priority-mutation";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  staleDocumentAssigneeConflict,
  staleDocumentTitleConflict,
} from "@repo/api/src/types/document-field-mutation";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureArtifactFieldEditAnalytics = vi.hoisted(() => vi.fn());

vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics,
}));

import { emitDocumentRefusalAnalytics } from "./document-field-edit-analytics";

const SHARED = {
  organizationId: "org-1",
  userId: "user-1",
  provenance: undefined,
};

beforeEach(() => {
  captureArtifactFieldEditAnalytics.mockReset();
});

describe("emitDocumentRefusalAnalytics", () => {
  it("uses stale-status code precedence instead of marking every requested field conflicted", () => {
    emitDocumentRefusalAnalytics({
      ...SHARED,
      requested: {
        status: IssueStatus.Done,
        priority: Priority.High,
        title: "Requested title",
      },
      error: {
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
        message: "stale status",
        details: {
          staleStatuses: [
            {
              documentId: "document-1",
              currentStatus: IssueStatus.InReview,
              expectedStatus: IssueStatus.Todo,
            },
          ],
        },
      },
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(1);
    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Conflict,
      artifactCount: 1,
      after: IssueStatus.Done,
    });
  });

  it("maps stale priority, title, and assignee codes to their exact fields", () => {
    const cases = [
      {
        requested: { priority: Priority.High },
        error: stalePriorityConflict([
          {
            documentId: "document-1",
            currentPriority: Priority.Low,
            expectedPriority: Priority.Medium,
          },
        ]),
        field: ArtifactFieldEditField.Priority,
      },
      {
        requested: { title: "Requested title" },
        error: staleDocumentTitleConflict({
          documentId: "document-1",
          currentTitle: "Current title",
          expectedTitle: "Old title",
        }),
        field: ArtifactFieldEditField.Title,
      },
      {
        requested: { assigneeId: "user-2" },
        error: staleDocumentAssigneeConflict({
          documentId: "document-1",
          currentAssigneeId: "user-3",
          expectedAssigneeId: "user-1",
        }),
        field: ArtifactFieldEditField.AssigneeId,
      },
    ] as const;

    for (const testCase of cases) {
      captureArtifactFieldEditAnalytics.mockClear();
      emitDocumentRefusalAnalytics({
        ...SHARED,
        requested: testCase.requested,
        error: testCase.error,
      });
      expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith(
        expect.objectContaining({
          field: testCase.field,
          result: ArtifactFieldEditOutcome.Conflict,
        })
      );
    }
  });

  it("maps an invalid reference only from the service-owned field detail", () => {
    emitDocumentRefusalAnalytics({
      ...SHARED,
      requested: { assigneeId: "user-2", projectId: "project-2" },
      error: {
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidReference,
        message: "projectId is invalid",
        details: { field: ArtifactFieldEditField.ProjectId, id: "project-2" },
      },
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(1);
    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.ProjectId,
        result: ArtifactFieldEditOutcome.ValidationFailed,
      })
    );
  });

  it("emits nothing for not-found or an unknown invalid-reference field", () => {
    emitDocumentRefusalAnalytics({
      ...SHARED,
      requested: { status: IssueStatus.Done },
      error: {
        status: Status.NotFound,
        code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
        message: "not found",
      },
    });
    emitDocumentRefusalAnalytics({
      ...SHARED,
      requested: { projectId: "project-2" },
      error: {
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidReference,
        message: "unknown reference",
        details: { field: "futureField", id: "value-1" },
      },
    });

    expect(captureArtifactFieldEditAnalytics).not.toHaveBeenCalled();
  });

  it("pins the canonical stale-priority literal used by precedence mapping", () => {
    expect(ArtifactPriorityMutationErrorCode.StalePriority).toBe(
      "stale_priority"
    );
  });
});
