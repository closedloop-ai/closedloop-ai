import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  ArtifactStatusCommitResult,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditValueClassification,
  buildArtifactFieldEditSnapshots,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordActivityEvent, reportFailure } = vi.hoisted(() => ({
  recordActivityEvent: vi.fn(),
  reportFailure: vi.fn(),
}));

vi.mock("@/app/documents/artifact-activity-service", () => ({
  artifactActivityService: { recordActivityEvent },
}));
vi.mock("@/lib/observability/artifact-activity-capture-telemetry", () => ({
  ArtifactActivityCaptureStage: { SingleUpdate: "single_update" },
  reportArtifactActivityCaptureFailure: reportFailure,
}));

import {
  captureSystemSessionMetadataChange,
  captureSystemSessionStatusChange,
} from "../artifact-activity-recording";
import {
  captureArtifactMetadataChange,
  captureSessionGroupingChanges,
} from "../artifact-field-edit-capture";

const tx = {} as Parameters<typeof captureArtifactMetadataChange>[0]["tx"];
const input = {
  tx,
  organizationId: "org-1",
  artifactId: "session-1",
  actorType: ArtifactActivityActorType.User,
  actorId: "user-1",
  action: ArtifactActivityAction.FieldChange,
  field: SessionMetadataActivityField.Name,
  before: "Old Name",
  after: "New Name",
} as const;

describe("captureArtifactMetadataChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordActivityEvent.mockResolvedValue(undefined);
  });

  it("records the actual field and actor on the writer transaction", async () => {
    await captureArtifactMetadataChange(input);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        artifactId: "session-1",
        actorType: ArtifactActivityActorType.User,
        actorId: "user-1",
        action: ArtifactActivityAction.FieldChange,
        before: {
          field: SessionMetadataActivityField.Name,
          value: "Old Name",
          valueClassification: ArtifactFieldEditValueClassification.Content,
        },
        after: {
          field: SessionMetadataActivityField.Name,
          value: "New Name",
          valueClassification: ArtifactFieldEditValueClassification.Content,
          result: ArtifactStatusCommitResult.Committed,
        },
      },
      tx
    );
  });

  it("does not record a no-op", async () => {
    await captureArtifactMetadataChange({ ...input, after: input.before });

    expect(recordActivityEvent).not.toHaveBeenCalled();
  });

  it("reports and propagates a failed receipt so the write rolls back", async () => {
    const failure = new Error("receipt unavailable");
    recordActivityEvent.mockRejectedValue(failure);

    await expect(captureArtifactMetadataChange(input)).rejects.toBe(failure);
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        artifactId: "session-1",
        field: ArtifactFieldEditField.Name,
        rolledBackReceiptCount: 1,
        error: failure,
      })
    );
  });
});

describe("captureSessionGroupingChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordActivityEvent.mockResolvedValue(undefined);
  });

  it("records each changed grouping field with one actor on the same transaction", async () => {
    await captureSessionGroupingChanges({
      tx,
      organizationId: "org-1",
      artifactId: "session-1",
      actor: { userId: "user-1", authMethod: "session" },
      before: {
        status: SESSION_STATUS.ACTIVE,
        projectId: null,
        ownerUserId: null,
      },
      after: {
        status: SESSION_STATUS.INACTIVE,
        projectId: "project-1",
        ownerUserId: "owner-1",
      },
    });

    expect(recordActivityEvent).toHaveBeenCalledTimes(3);
    expect(recordActivityEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorType: ArtifactActivityActorType.User,
        actorId: "user-1",
        action: ArtifactActivityAction.StatusChange,
        before: SESSION_STATUS.ACTIVE,
        after: SESSION_STATUS.INACTIVE,
      }),
      tx
    );
    expect(recordActivityEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: ArtifactActivityAction.FieldChange,
        before: {
          field: SessionMetadataActivityField.ProjectId,
          value: null,
          valueClassification: ArtifactFieldEditValueClassification.Absent,
        },
        after: {
          field: SessionMetadataActivityField.ProjectId,
          value: "project-1",
          valueClassification: ArtifactFieldEditValueClassification.Reference,
          result: ArtifactStatusCommitResult.Committed,
        },
      }),
      tx
    );
    expect(recordActivityEvent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        action: ArtifactActivityAction.Assignment,
        // ISS-12251 D-1: the generic assignee envelope documents use.
        before: {
          field: SessionMetadataActivityField.AssigneeId,
          value: null,
          valueClassification: ArtifactFieldEditValueClassification.Absent,
        },
        after: {
          field: SessionMetadataActivityField.AssigneeId,
          value: "owner-1",
          valueClassification: ArtifactFieldEditValueClassification.Reference,
          result: ArtifactStatusCommitResult.Committed,
        },
      }),
      tx
    );
  });

  it("records no receipt when the grouping values are unchanged", async () => {
    await captureSessionGroupingChanges({
      tx,
      organizationId: "org-1",
      artifactId: "session-1",
      actor: { userId: "user-1", authMethod: "session" },
      before: {
        status: SESSION_STATUS.ACTIVE,
        projectId: null,
        ownerUserId: null,
      },
      after: {
        status: SESSION_STATUS.ACTIVE,
        projectId: null,
        ownerUserId: null,
      },
    });

    expect(recordActivityEvent).not.toHaveBeenCalled();
  });
});

describe("captureSystemSessionStatusChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordActivityEvent.mockResolvedValue(undefined);
  });

  it("records a system-attributed status transition, not a human collaborator", async () => {
    await captureSystemSessionStatusChange({
      tx,
      organizationId: "org-1",
      artifactId: "session-1",
      before: SESSION_STATUS.ACTIVE,
      after: SESSION_STATUS.ERROR,
    });

    expect(recordActivityEvent).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        artifactId: "session-1",
        actorType: ArtifactActivityActorType.System,
        actorId: null,
        action: ArtifactActivityAction.StatusChange,
        before: SESSION_STATUS.ACTIVE,
        after: SESSION_STATUS.ERROR,
      },
      tx
    );
  });

  it("does not record a same-status ingest retry", async () => {
    await captureSystemSessionStatusChange({
      tx,
      organizationId: "org-1",
      artifactId: "session-1",
      before: SESSION_STATUS.ACTIVE,
      after: SESSION_STATUS.ACTIVE,
    });

    expect(recordActivityEvent).not.toHaveBeenCalled();
  });
});

describe("captureSystemSessionMetadataChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordActivityEvent.mockResolvedValue(undefined);
  });

  it("records the net project change as System on the writer transaction", async () => {
    await captureSystemSessionMetadataChange({
      tx,
      organizationId: "org-1",
      artifactId: "session-1",
      field: SessionMetadataActivityField.ProjectId,
      before: "project-old",
      after: "project-new",
    });

    expect(recordActivityEvent).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        artifactId: "session-1",
        actorType: ArtifactActivityActorType.System,
        actorId: null,
        action: ArtifactActivityAction.FieldChange,
        ...buildArtifactFieldEditSnapshots({
          field: ArtifactFieldEditField.ProjectId,
          before: "project-old",
          after: "project-new",
        }),
      },
      tx
    );
  });

  it("does not record a project re-import that changes nothing", async () => {
    await captureSystemSessionMetadataChange({
      tx,
      organizationId: "org-1",
      artifactId: "session-1",
      field: SessionMetadataActivityField.ProjectId,
      before: "project-1",
      after: "project-1",
    });

    expect(recordActivityEvent).not.toHaveBeenCalled();
  });
});
