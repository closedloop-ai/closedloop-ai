import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { stalePriorityConflict } from "@repo/api/src/types/artifact-priority-mutation";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureArtifactFieldEditAnalytics = vi.hoisted(() => vi.fn());

vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics,
}));

import {
  emitBatchFieldEditRefusalAnalytics,
  emitBatchItemFieldEditRefusalAnalytics,
} from "./batch-field-edit-refusal-analytics";

const SHARED = {
  organizationId: "org-1",
  userId: "user-1",
  authMethod: "session" as const,
  surface: ArtifactStatusEditSurface.Bulk,
};

const EXPECTED_SHARED = {
  organizationId: SHARED.organizationId,
  userId: SHARED.userId,
  provenance: {
    surface: SHARED.surface,
    commitGroupId: expect.any(String),
  },
};

beforeEach(() => {
  captureArtifactFieldEditAnalytics.mockReset();
});

describe("emitBatchFieldEditRefusalAnalytics", () => {
  it("maps exact status validation and priority conflict codes", () => {
    emitBatchFieldEditRefusalAnalytics({
      ...SHARED,
      field: ArtifactFieldEditField.Status,
      after: "DONE",
      error: {
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
        details: {
          invalidStatuses: [
            {
              documentId: "document-1",
              currentStatus: "DRAFT",
              targetStatus: "DONE",
              subtype: null,
              allowedStatuses: [],
            },
            {
              documentId: "document-2",
              currentStatus: "DRAFT",
              targetStatus: "DONE",
              subtype: null,
              allowedStatuses: [],
            },
          ],
        },
      },
    });
    emitBatchFieldEditRefusalAnalytics({
      ...SHARED,
      field: ArtifactFieldEditField.Priority,
      after: Priority.High,
      error: stalePriorityConflict([
        {
          documentId: "document-1",
          currentPriority: Priority.Low,
          expectedPriority: Priority.Medium,
        },
      ]),
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenNthCalledWith(1, {
      ...EXPECTED_SHARED,
      field: ArtifactFieldEditField.Status,
      after: "DONE",
      result: ArtifactFieldEditOutcome.ValidationFailed,
      artifactCount: 2,
    });
    expect(captureArtifactFieldEditAnalytics).toHaveBeenNthCalledWith(2, {
      ...EXPECTED_SHARED,
      field: ArtifactFieldEditField.Priority,
      after: Priority.High,
      result: ArtifactFieldEditOutcome.Conflict,
      artifactCount: 1,
    });
  });

  it("omits artifactCount when a v1 refusal carries no typed detail count", () => {
    emitBatchFieldEditRefusalAnalytics({
      ...SHARED,
      field: ArtifactFieldEditField.Status,
      error: {
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
      },
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      ...EXPECTED_SHARED,
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Conflict,
    });
  });

  it("omits forged UI provenance from API-key refusals", () => {
    emitBatchFieldEditRefusalAnalytics({
      ...SHARED,
      authMethod: "api_key",
      field: ArtifactFieldEditField.Status,
      error: {
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
      },
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: SHARED.organizationId,
      userId: SHARED.userId,
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Conflict,
    });
  });

  it("does not classify not-found or unknown codes as validation/conflict", () => {
    for (const error of [
      {
        status: Status.NotFound,
        code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
      },
      { status: Status.BadRequest, code: "future_failure" },
    ]) {
      emitBatchFieldEditRefusalAnalytics({
        ...SHARED,
        field: ArtifactFieldEditField.Status,
        error,
      });
    }

    expect(captureArtifactFieldEditAnalytics).not.toHaveBeenCalled();
  });
});

describe("emitBatchItemFieldEditRefusalAnalytics", () => {
  it("aggregates mixed v2 failures by exact outcome without record ids", () => {
    emitBatchItemFieldEditRefusalAnalytics({
      ...SHARED,
      field: ArtifactFieldEditField.Status,
      after: "DONE",
      results: [
        batchItemApplied("applied-secret-id"),
        batchItemFailed(
          "invalid-secret-id",
          BatchItemFailureCode.InvalidStatusForSubtype
        ),
        batchItemFailed("stale-secret-id-1", BatchItemFailureCode.StaleStatus),
        batchItemFailed("stale-secret-id-2", BatchItemFailureCode.StaleStatus),
        batchItemFailed(
          "missing-secret-id",
          BatchItemFailureCode.ArtifactsNotFound
        ),
      ],
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(2);
    expect(captureArtifactFieldEditAnalytics).toHaveBeenNthCalledWith(1, {
      ...EXPECTED_SHARED,
      field: ArtifactFieldEditField.Status,
      after: "DONE",
      result: ArtifactFieldEditOutcome.ValidationFailed,
      artifactCount: 1,
    });
    expect(captureArtifactFieldEditAnalytics).toHaveBeenNthCalledWith(2, {
      ...EXPECTED_SHARED,
      field: ArtifactFieldEditField.Status,
      after: "DONE",
      result: ArtifactFieldEditOutcome.Conflict,
      artifactCount: 2,
    });
    expect(
      JSON.stringify(captureArtifactFieldEditAnalytics.mock.calls)
    ).not.toContain("secret-id");
  });
});
