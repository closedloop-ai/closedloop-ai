import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import { Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { ArtifactType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactActivityCaptureStage } from "@/lib/observability/artifact-activity-capture-telemetry";

const mocks = vi.hoisted(() => ({
  captureBatchPriorityChange: vi.fn(),
  captureArtifactFieldEditAnalytics: vi.fn(),
  dispatchSingleArtifactMutationAudits: vi.fn(),
  updatePriorityAfterCommit: vi.fn(),
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchPriorityChange: mocks.captureBatchPriorityChange,
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: mocks.captureArtifactFieldEditAnalytics,
}));
vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: {
    updatePriorityAfterCommit: mocks.updatePriorityAfterCommit,
  },
}));
vi.mock("@/app/audit/single-artifact-mutation-audit", () => ({
  dispatchSingleArtifactMutationAudits:
    mocks.dispatchSingleArtifactMutationAudits,
}));

import {
  captureSinglePriorityActivity,
  emitSinglePriorityRefusalAnalytics,
  emitSinglePrioritySideEffects,
} from "./single-priority-side-effects";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222221";
const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const BRANCH_ID = "66666666-6666-4666-8666-666666666661";

const user = { id: USER_ID, organizationId: ORG_ID };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitSinglePrioritySideEffects (ISS-10332, PLN-2086 Milestone 2)", () => {
  it("ISS-10681 AC-001 audits Session and Branch priority transitions at the shared host", () => {
    emitSinglePrioritySideEffects({
      user,
      authMethod: "session",
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      priority: Priority.Urgent,
      written: { changed: true, beforePriority: Priority.Low },
    });
    emitSinglePrioritySideEffects({
      user,
      authMethod: "session",
      artifactId: BRANCH_ID,
      artifactType: ArtifactType.BRANCH,
      priority: null,
      written: { changed: true, beforePriority: Priority.High },
    });

    expect(mocks.dispatchSingleArtifactMutationAudits.mock.calls).toEqual([
      [
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          changes: [
            {
              action: AuditAction.DocumentPriorityChanged,
              objectId: SESSION_ID,
              before: Priority.Low,
              after: Priority.Urgent,
            },
          ],
        },
      ],
      [
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          changes: [
            {
              action: AuditAction.DocumentPriorityChanged,
              objectId: BRANCH_ID,
              before: Priority.High,
              after: null,
            },
          ],
        },
      ],
    ]);
  });

  it("re-projects the BRANCH row under its own entity kind, and a clear as null", () => {
    emitSinglePrioritySideEffects({
      user,
      authMethod: "session",
      artifactId: BRANCH_ID,
      artifactType: ArtifactType.BRANCH,
      priority: null,
      written: { changed: true, beforePriority: Priority.Low },
    });

    expect(mocks.updatePriorityAfterCommit).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        entityType: SearchEntityType.Branch,
        entityId: BRANCH_ID,
      },
      null
    );
  });

  it("emits ONE analytics event, attributed to the named surface, with the before/after pair", () => {
    emitSinglePrioritySideEffects({
      user,
      authMethod: "session",
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.InlineCell,
      written: { changed: true, beforePriority: Priority.Low },
    });

    expect(mocks.captureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(1);
    expect(mocks.captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: USER_ID,
      field: ArtifactFieldEditField.Priority,
      result: ArtifactFieldEditOutcome.Committed,
      provenance: { surface: ArtifactStatusEditSurface.InlineCell },
      before: Priority.Low,
      after: Priority.Urgent,
      artifactCount: 1,
    });
  });

  it("emits unattributed analytics when provenance is omitted or withheld", () => {
    emitSinglePrioritySideEffects({
      user,
      authMethod: "session",
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      priority: Priority.Urgent,
      written: { changed: true, beforePriority: Priority.Low },
    });
    emitSinglePrioritySideEffects({
      user,
      authMethod: "api_key",
      artifactId: BRANCH_ID,
      artifactType: ArtifactType.BRANCH,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.InlineCell,
      written: { changed: true, beforePriority: Priority.Low },
    });

    expect(mocks.captureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(2);
    for (const [event] of mocks.captureArtifactFieldEditAnalytics.mock.calls) {
      expect(event).toEqual({
        organizationId: ORG_ID,
        userId: USER_ID,
        field: ArtifactFieldEditField.Priority,
        result: ArtifactFieldEditOutcome.Committed,
        before: Priority.Low,
        after: Priority.Urgent,
        artifactCount: 1,
      });
    }
    expect(mocks.dispatchSingleArtifactMutationAudits).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchSingleArtifactMutationAudits).toHaveBeenNthCalledWith(
      2,
      {
        organizationId: ORG_ID,
        userId: USER_ID,
        changes: [
          {
            action: AuditAction.DocumentPriorityChanged,
            objectId: BRANCH_ID,
            before: Priority.Low,
            after: Priority.Urgent,
          },
        ],
      }
    );
    // The write itself still re-projects on both paths. The receipt is no
    // longer emitted here at all (ISS-10993) — see the describe below.
    expect(mocks.updatePriorityAfterCommit).toHaveBeenCalledTimes(2);
  });

  it("emits no legacy side effect for a no-op but records the no_change outcome", () => {
    emitSinglePrioritySideEffects({
      user,
      authMethod: "session",
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.InlineCell,
      written: { changed: false, beforePriority: Priority.High },
    });

    expect(mocks.updatePriorityAfterCommit).not.toHaveBeenCalled();
    expect(mocks.captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: USER_ID,
      field: ArtifactFieldEditField.Priority,
      result: ArtifactFieldEditOutcome.NoChange,
      provenance: { surface: ArtifactStatusEditSurface.InlineCell },
      before: Priority.High,
      after: Priority.High,
      artifactCount: 1,
    });
    expect(mocks.dispatchSingleArtifactMutationAudits).not.toHaveBeenCalled();
  });

  it("isolates each emission: a throwing re-projection does not cost the event", () => {
    mocks.updatePriorityAfterCommit.mockImplementation(() => {
      throw new Error("index down");
    });

    expect(() =>
      emitSinglePrioritySideEffects({
        user,
        authMethod: "session",
        artifactId: SESSION_ID,
        artifactType: ArtifactType.SESSION,
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.Detail,
        written: { changed: true, beforePriority: null },
      })
    ).not.toThrow();
    expect(mocks.captureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: USER_ID,
      changes: [
        {
          action: AuditAction.DocumentPriorityChanged,
          objectId: SESSION_ID,
          before: null,
          after: Priority.High,
        },
      ],
    });
  });
});

/**
 * ISS-10993 — the receipt half, at its new owner: it runs inside the priority
 * write's own transaction and REJECTS on failure, so the write rolls back with
 * it rather than committing a change the feed will never show.
 */
describe("captureSinglePriorityActivity", () => {
  it("records the transition on the caller's transaction, through the bulk shape", async () => {
    await captureSinglePriorityActivity(PRIORITY_TX, {
      user,
      authMethod: "session",
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      priority: Priority.Urgent,
      written: { changed: true, beforePriority: Priority.Low },
    });

    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledWith({
      tx: PRIORITY_TX,
      organizationId: ORG_ID,
      actor: { userId: user.id, authMethod: "session" },
      provenance: undefined,
      changes: [
        {
          artifactId: SESSION_ID,
          before: Priority.Low,
          after: Priority.Urgent,
        },
      ],
      stage: ArtifactActivityCaptureStage.SingleUpdate,
    });
  });

  it("records nothing for a no-op re-apply", async () => {
    await captureSinglePriorityActivity(PRIORITY_TX, {
      user,
      authMethod: "session",
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      priority: Priority.High,
      written: { changed: false, beforePriority: Priority.High },
    });

    expect(mocks.captureBatchPriorityChange).not.toHaveBeenCalled();
  });

  it("REJECTS when the receipt cannot be written, so the write rolls back", async () => {
    mocks.captureBatchPriorityChange.mockRejectedValue(
      new Error("receipt down")
    );

    await expect(
      captureSinglePriorityActivity(PRIORITY_TX, {
        user,
        authMethod: "session",
        artifactId: SESSION_ID,
        artifactType: ArtifactType.SESSION,
        priority: Priority.High,
        written: { changed: true, beforePriority: null },
      })
    ).rejects.toThrow("receipt down");
  });

  it("passes only validated human provenance to the atomic receipt", async () => {
    await captureSinglePriorityActivity(PRIORITY_TX, {
      user,
      authMethod: "session",
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.Detail,
      written: { changed: true, beforePriority: Priority.Low },
    });

    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { surface: ArtifactStatusEditSurface.Detail },
      })
    );
  });
});

describe("emitSinglePriorityRefusalAnalytics", () => {
  it.each([
    [Status.BadRequest, ArtifactFieldEditOutcome.ValidationFailed],
    [Status.Conflict, ArtifactFieldEditOutcome.Conflict],
  ] as const)("maps %s to %s", (status, result) => {
    emitSinglePriorityRefusalAnalytics(
      {
        user,
        authMethod: "session",
        artifactId: SESSION_ID,
        artifactType: ArtifactType.SESSION,
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.InlineCell,
      },
      status
    );

    expect(mocks.captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: USER_ID,
      field: ArtifactFieldEditField.Priority,
      result,
      provenance: { surface: ArtifactStatusEditSurface.InlineCell },
      after: Priority.High,
      artifactCount: 1,
    });
  });

  it("emits no field-edit outcome for permission or not-found refusals", () => {
    for (const status of [Status.Forbidden, Status.NotFound]) {
      emitSinglePriorityRefusalAnalytics(
        {
          user,
          authMethod: "session",
          artifactId: SESSION_ID,
          artifactType: ArtifactType.SESSION,
          priority: Priority.High,
        },
        status
      );
    }

    expect(mocks.captureArtifactFieldEditAnalytics).not.toHaveBeenCalled();
  });
});

/** Stands in for the priority write's transaction client. */
const PRIORITY_TX = { __brand: "priority-tx" } as never;
