import { staleSessionFieldsConflict } from "@repo/api/src/types/agent-session-field-mutation";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureArtifactFieldEditAnalytics = vi.hoisted(() => vi.fn());

vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics,
}));

import {
  buildSessionConflictAnalyticsChanges,
  buildSessionGroupingAnalyticsChanges,
  emitSessionGroupingAnalytics,
} from "./session-field-edit-analytics";

beforeEach(() => {
  captureArtifactFieldEditAnalytics.mockReset();
});

describe("buildSessionGroupingAnalyticsChanges", () => {
  it("builds only the fields present in the requested grouping patch", () => {
    expect(
      buildSessionGroupingAnalyticsChanges(
        { status: "active", projectId: "project-1", ownerUserId: "user-1" },
        { status: "inactive", projectId: null }
      )
    ).toEqual([
      {
        field: ArtifactFieldEditField.Status,
        before: "active",
        after: "inactive",
      },
      {
        field: ArtifactFieldEditField.ProjectId,
        before: "project-1",
        after: null,
      },
    ]);
  });
});

describe("buildSessionConflictAnalyticsChanges", () => {
  it("maps only fields named by the stale details, even when other fields were requested", () => {
    const conflict = staleSessionFieldsConflict({
      status: {
        documentId: "session-1",
        currentStatus: "active",
        expectedStatus: "error",
      },
      ownerUserId: {
        documentId: "session-1",
        currentOwnerUserId: "user-1",
        expectedOwnerUserId: null,
      },
    });
    if (conflict === null) {
      throw new Error("expected a stale-field conflict");
    }

    expect(
      buildSessionConflictAnalyticsChanges(conflict, {
        status: "inactive",
        projectId: "project-2",
        ownerUserId: "user-2",
      })
    ).toEqual([
      { field: ArtifactFieldEditField.Status, after: "inactive" },
      { field: ArtifactFieldEditField.AssigneeId, after: "user-2" },
    ]);
  });
});

describe("emitSessionGroupingAnalytics", () => {
  it("emits committed and same-value retry outcomes from locked values", () => {
    emitSessionGroupingAnalytics({
      organizationId: "org-1",
      userId: "user-1",
      changes: [
        {
          field: ArtifactFieldEditField.Status,
          before: "active",
          after: "inactive",
        },
        {
          field: ArtifactFieldEditField.ProjectId,
          before: "project-1",
          after: "project-1",
        },
      ],
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenNthCalledWith(1, {
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
      before: "active",
      after: "inactive",
    });
    expect(captureArtifactFieldEditAnalytics).toHaveBeenNthCalledWith(2, {
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.ProjectId,
      result: ArtifactFieldEditOutcome.NoChange,
      artifactCount: 1,
      before: "project-1",
      after: "project-1",
    });
  });

  it("emits conflicts without fabricating missing prior values", () => {
    emitSessionGroupingAnalytics({
      organizationId: "org-1",
      userId: "user-1",
      changes: [
        {
          field: ArtifactFieldEditField.AssigneeId,
          after: "requested-owner-id",
        },
      ],
      forcedResult: ArtifactFieldEditOutcome.Conflict,
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.AssigneeId,
      result: ArtifactFieldEditOutcome.Conflict,
      artifactCount: 1,
      after: "requested-owner-id",
    });
    expect(
      captureArtifactFieldEditAnalytics.mock.calls[0][0]
    ).not.toHaveProperty("before");
  });

  it("delegates every field to the shared failure-isolating adapter", () => {
    emitSessionGroupingAnalytics({
      organizationId: "org-1",
      userId: "user-1",
      changes: [
        { field: ArtifactFieldEditField.Status, after: "inactive" },
        { field: ArtifactFieldEditField.ProjectId, after: null },
      ],
    });
    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(2);
  });

  it("forwards canonical grouped provenance unchanged", () => {
    const provenance = {
      surface: ArtifactStatusEditSurface.Board,
      commitGroupId: "board-commit-1",
    } as const;

    emitSessionGroupingAnalytics({
      organizationId: "org-1",
      userId: "user-1",
      changes: [{ field: ArtifactFieldEditField.Status, after: "inactive" }],
      provenance,
    });

    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
      provenance,
      after: "inactive",
    });
  });
});
