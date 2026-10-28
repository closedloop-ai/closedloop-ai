import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  ArtifactStatusCommitResult,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { TransactionClient } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
  ArtifactActivityCaptureStage,
  clearArtifactActivityCaptureFailureThrottle,
} from "@/lib/observability/artifact-activity-capture-telemetry";

const recordActivityEvent = vi.hoisted(() => vi.fn());
const recordActivityEvents = vi.hoisted(() => vi.fn());
const captureImmediate = vi.hoisted(() => vi.fn());
const scheduled = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("@/app/documents/artifact-activity-service", () => ({
  artifactActivityService: { recordActivityEvent, recordActivityEvents },
}));

vi.mock("@repo/analytics/node", () => ({
  nodeAnalytics: { captureImmediate },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    scheduled.push(Promise.resolve(promise).catch(() => undefined));
  }),
}));

const logError = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/log", () => ({
  log: { error: logError, info: vi.fn(), warn: vi.fn() },
}));

import {
  type CapturedArtifactFields,
  captureArtifactCreation,
  captureArtifactUpdate,
  captureAutomatedUnblock,
  captureBatchPriorityChange,
  captureBatchProjectChange,
  captureBatchStatusChange,
  diffArtifactFields,
  resolveActorType,
} from "../artifact-activity-capture";
import { ArtifactFieldEditLineage } from "../artifact-field-edit-analytics";

/**
 * The caller's transaction client. Opaque here on purpose: the store is mocked,
 * so nothing calls a method on it — what these tests pin is that the SAME client
 * the caller owns reaches the store, which is what makes the receipt commit with
 * the mutation.
 */
const TX = { __brand: "tx" } as unknown as TransactionClient;

const ORG = "org-1";
const ARTIFACT = "artifact-1";
const USER = "user-1";

function fields(
  over: Partial<CapturedArtifactFields> = {}
): CapturedArtifactFields {
  return {
    status: "DRAFT",
    assigneeId: null,
    approverId: null,
    priority: "MEDIUM",
    title: "Doc",
    dueDate: null,
    projectId: "proj-1",
    ...over,
  };
}

beforeEach(() => {
  recordActivityEvent.mockReset();
  recordActivityEvent.mockResolvedValue(undefined);
  recordActivityEvents.mockReset();
  recordActivityEvents.mockImplementation(
    async (input: { events: unknown[] }) => input.events.length
  );
  captureImmediate.mockReset().mockResolvedValue(undefined);
  scheduled.length = 0;
  clearArtifactActivityCaptureFailureThrottle();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("resolveActorType", () => {
  it("maps api_key to agent and session/desktop to user", () => {
    expect(resolveActorType("api_key")).toBe(ArtifactActivityActorType.Agent);
    expect(resolveActorType("session")).toBe(ArtifactActivityActorType.User);
    expect(resolveActorType("desktop_session")).toBe(
      ArtifactActivityActorType.User
    );
  });
});

describe("diffArtifactFields", () => {
  it("returns no changes for a no-op update (no double-count)", () => {
    expect(diffArtifactFields(fields(), fields())).toEqual([]);
  });

  it("emits a status_change for a status transition", () => {
    const changes = diffArtifactFields(
      fields({ status: "DRAFT" }),
      fields({ status: "IN_REVIEW" })
    );
    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.StatusChange,
        before: "DRAFT",
        after: "IN_REVIEW",
      },
    ]);
  });

  it("names which role moved on assignee and approver changes", () => {
    const changes = diffArtifactFields(
      fields({ assigneeId: null, approverId: "a-old" }),
      fields({ assigneeId: "u-new", approverId: "a-new" })
    );
    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.Assignment,
        before: classified(
          "assigneeId",
          null,
          ArtifactFieldEditValueClassification.Absent
        ),
        after: committed(
          "assigneeId",
          "u-new",
          ArtifactFieldEditValueClassification.Reference
        ),
      },
      {
        action: ArtifactActivityAction.Assignment,
        before: classified(
          "approverId",
          "a-old",
          ArtifactFieldEditValueClassification.Reference
        ),
        after: committed(
          "approverId",
          "a-new",
          ArtifactFieldEditValueClassification.Reference
        ),
      },
    ]);
  });

  it("emits field_change for title/priority/dueDate/project changes", () => {
    const changes = diffArtifactFields(
      fields({ title: "Old", priority: "LOW", projectId: "p1" }),
      fields({ title: "New", priority: "HIGH", projectId: "p2" })
    );
    expect(changes.map((c) => c.action)).toEqual([
      ArtifactActivityAction.FieldChange,
      ArtifactActivityAction.FieldChange,
      ArtifactActivityAction.FieldChange,
    ]);
    expect(changes[0].after).toEqual(
      committed(
        "priority",
        "HIGH",
        ArtifactFieldEditValueClassification.Enumerated
      )
    );
    expect(changes[1].after).toEqual(
      committed("title", "New", ArtifactFieldEditValueClassification.Content)
    );
    expect(changes[2].after).toEqual(
      committed(
        "projectId",
        "p2",
        ArtifactFieldEditValueClassification.Reference
      )
    );
  });

  it("records NULL → MEDIUM, the transition the fold made invisible (ISS-9665)", () => {
    const changes = diffArtifactFields(
      fields({ priority: null }),
      fields({ priority: "MEDIUM" })
    );

    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.FieldChange,
        before: classified(
          "priority",
          null,
          ArtifactFieldEditValueClassification.Absent
        ),
        after: committed(
          "priority",
          "MEDIUM",
          ArtifactFieldEditValueClassification.Enumerated
        ),
      },
    ]);
  });

  it("records the NULL → first-value priority transition (ISS-9665)", () => {
    const changes = diffArtifactFields(
      fields({ priority: null }),
      fields({ priority: "HIGH" })
    );

    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.FieldChange,
        before: classified(
          "priority",
          null,
          ArtifactFieldEditValueClassification.Absent
        ),
        after: committed(
          "priority",
          "HIGH",
          ArtifactFieldEditValueClassification.Enumerated
        ),
      },
    ]);
  });

  it("records CLEARING a priority as a change back to unset", () => {
    const changes = diffArtifactFields(
      fields({ priority: "HIGH" }),
      fields({ priority: null })
    );

    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.FieldChange,
        before: classified(
          "priority",
          "HIGH",
          ArtifactFieldEditValueClassification.Enumerated
        ),
        after: committed(
          "priority",
          null,
          ArtifactFieldEditValueClassification.Absent
        ),
      },
    ]);
  });

  it("records nothing when an unset priority stays unset", () => {
    expect(
      diffArtifactFields(fields({ priority: null }), fields({ priority: null }))
    ).toEqual([]);
  });

  it("normalizes dueDate to ISO and ignores equal timestamps", () => {
    const same = new Date("2026-07-22T00:00:00.000Z");
    expect(
      diffArtifactFields(
        fields({ dueDate: same }),
        fields({ dueDate: new Date(same.getTime()) })
      )
    ).toEqual([]);

    const changed = diffArtifactFields(
      fields({ dueDate: null }),
      fields({ dueDate: same })
    );
    expect(changed).toEqual([
      {
        action: ArtifactActivityAction.FieldChange,
        before: classified(
          "dueDate",
          null,
          ArtifactFieldEditValueClassification.Absent
        ),
        after: committed(
          "dueDate",
          same.toISOString(),
          ArtifactFieldEditValueClassification.Date
        ),
      },
    ]);
  });

  it("emits multiple events when several fields change at once", () => {
    const changes = diffArtifactFields(
      fields({ status: "DRAFT", assigneeId: null }),
      fields({ status: "APPROVED", assigneeId: "u-2" })
    );
    expect(changes).toHaveLength(2);
  });
});

describe("captureArtifactUpdate", () => {
  it("records one event per changed field, attributed to the actor", async () => {
    await captureArtifactUpdate({
      tx: TX,
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "session" },
      before: fields({ status: "DRAFT" }),
      after: fields({ status: "IN_REVIEW" }),
    });

    expect(recordActivityEvent).toHaveBeenCalledTimes(1);
    expect(recordActivityEvent).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        artifactId: ARTIFACT,
        actorType: ArtifactActivityActorType.User,
        actorId: USER,
        action: ArtifactActivityAction.StatusChange,
        before: "DRAFT",
        after: "IN_REVIEW",
      },
      TX
    );
  });

  it("attributes an api-key caller as an agent", async () => {
    await captureArtifactUpdate({
      tx: TX,
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "api_key" },
      before: fields({ assigneeId: null }),
      after: fields({ assigneeId: "u-2" }),
    });

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: ArtifactActivityActorType.Agent }),
      TX
    );
  });

  it("carries placement transaction and Undo identity onto lane activity", async () => {
    await captureArtifactUpdate({
      actor: { authMethod: "session", userId: USER },
      after: fields({ status: "TODO" }),
      artifactId: ARTIFACT,
      before: fields({ status: "IN_PROGRESS" }),
      organizationId: ORG,
      transactionId: "11111111-1111-7111-8111-111111111111",
      tx: TX,
      undoOfTransactionId: "22222222-2222-7222-8222-222222222222",
    });

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "11111111-1111-7111-8111-111111111111",
        undoOfTransactionId: "22222222-2222-7222-8222-222222222222",
      }),
      TX
    );
  });

  it("records nothing for a no-op update", async () => {
    await captureArtifactUpdate({
      tx: TX,
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "session" },
      before: fields(),
      after: fields(),
    });
    expect(recordActivityEvent).not.toHaveBeenCalled();
  });

  it("ATOMICITY: a record rejection propagates, so the mutation rolls back", async () => {
    recordActivityEvent.mockRejectedValue(new Error("db down"));
    await expect(
      captureArtifactUpdate({
        tx: TX,
        organizationId: ORG,
        artifactId: ARTIFACT,
        actor: { userId: USER, authMethod: "session" },
        before: fields({ status: "DRAFT" }),
        after: fields({ status: "IN_REVIEW" }),
      })
    ).rejects.toThrow("db down");
    expect(recordActivityEvent).toHaveBeenCalledTimes(1);
  });
});

describe("captureBatchStatusChange", () => {
  it("records the moved artifacts in a SINGLE batched call (not one per row)", async () => {
    await captureBatchStatusChange({
      tx: TX,
      organizationId: ORG,
      actor: { userId: USER, authMethod: "session" },
      changes: [
        { artifactId: "a1", before: "DRAFT", after: "APPROVED" },
        { artifactId: "a2", before: "APPROVED", after: "APPROVED" }, // no-op
        { artifactId: "a3", before: "IN_REVIEW", after: "APPROVED" },
      ],
    });

    // Bounded fan-out: the whole batch goes through one batched insert call, so
    // a 500-item batch cannot spawn 500 concurrent transactions on the write
    // path. The per-row `recordActivityEvent` must NOT be used here.
    expect(recordActivityEvent).not.toHaveBeenCalled();
    expect(recordActivityEvents).toHaveBeenCalledTimes(1);
    expect(recordActivityEvents).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        events: [
          {
            artifactId: "a1",
            actorType: ArtifactActivityActorType.User,
            actorId: USER,
            action: ArtifactActivityAction.StatusChange,
            before: "DRAFT",
            after: "APPROVED",
          },
          {
            artifactId: "a3",
            actorType: ArtifactActivityActorType.User,
            actorId: USER,
            action: ArtifactActivityAction.StatusChange,
            before: "IN_REVIEW",
            after: "APPROVED",
          },
        ],
      },
      TX
    );
  });

  it("records nothing when no status actually moved", async () => {
    await captureBatchStatusChange({
      tx: TX,
      organizationId: ORG,
      actor: { userId: USER, authMethod: "session" },
      changes: [{ artifactId: "a1", before: "APPROVED", after: "APPROVED" }],
    });
    expect(recordActivityEvents).not.toHaveBeenCalled();
  });

  it("ATOMICITY: a batched-record rejection propagates, so the batch rolls back", async () => {
    recordActivityEvents.mockRejectedValue(new Error("db down"));
    await expect(
      captureBatchStatusChange({
        tx: TX,
        organizationId: ORG,
        actor: { userId: USER, authMethod: "session" },
        changes: [{ artifactId: "a1", before: "DRAFT", after: "APPROVED" }],
      })
    ).rejects.toThrow("db down");
    expect(recordActivityEvents).toHaveBeenCalledTimes(1);
  });
});

describe("captureBatchProjectChange", () => {
  it("records one field_change per artifact whose project moved, in ONE batched call", async () => {
    await captureBatchProjectChange({
      tx: TX,
      organizationId: ORG,
      actor: { userId: USER, authMethod: "session" },
      changes: [
        { artifactId: "a1", before: "proj-a", after: "proj-b" },
        { artifactId: "a2", before: "proj-b", after: "proj-b" },
        { artifactId: "a3", before: null, after: "proj-b" },
      ],
    });

    expect(recordActivityEvent).not.toHaveBeenCalled();
    expect(recordActivityEvents).toHaveBeenCalledTimes(1);
    expect(recordActivityEvents).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        events: [
          {
            artifactId: "a1",
            actorType: ArtifactActivityActorType.User,
            actorId: USER,
            action: ArtifactActivityAction.FieldChange,
            before: classified(
              "projectId",
              "proj-a",
              ArtifactFieldEditValueClassification.Reference
            ),
            after: committed(
              "projectId",
              "proj-b",
              ArtifactFieldEditValueClassification.Reference
            ),
          },
          {
            artifactId: "a3",
            actorType: ArtifactActivityActorType.User,
            actorId: USER,
            action: ArtifactActivityAction.FieldChange,
            before: classified(
              "projectId",
              null,
              ArtifactFieldEditValueClassification.Absent
            ),
            after: committed(
              "projectId",
              "proj-b",
              ArtifactFieldEditValueClassification.Reference
            ),
          },
        ],
        transactionId: undefined,
        undoOfTransactionId: undefined,
      },
      TX
    );
  });

  it("attributes an api_key caller as an agent", async () => {
    await captureBatchProjectChange({
      tx: TX,
      organizationId: ORG,
      actor: { userId: USER, authMethod: "api_key" },
      changes: [{ artifactId: "a1", before: "proj-a", after: "proj-b" }],
    });

    expect(recordActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            actorType: ArtifactActivityActorType.Agent,
            actorId: USER,
          }),
        ],
      }),
      TX
    );
  });

  it("preserves validated provenance omission even with a transaction id", async () => {
    await captureBatchProjectChange({
      tx: TX,
      organizationId: ORG,
      actor: { userId: USER, authMethod: "session" },
      changes: [{ artifactId: "a1", before: "proj-a", after: "proj-b" }],
      transactionId: "private-transaction-id",
      preserveProvenanceOmission: true,
    });

    expect(recordActivityEvents).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        events: [
          expect.objectContaining({
            before: expect.not.objectContaining({ surface: expect.anything() }),
            after: expect.not.objectContaining({ surface: expect.anything() }),
          }),
        ],
        transactionId: "private-transaction-id",
        undoOfTransactionId: undefined,
      },
      TX
    );
  });

  it("records nothing when every artifact was already in the target project", async () => {
    await captureBatchProjectChange({
      tx: TX,
      organizationId: ORG,
      actor: { userId: USER, authMethod: "session" },
      changes: [{ artifactId: "a1", before: "proj-b", after: "proj-b" }],
    });
    expect(recordActivityEvents).not.toHaveBeenCalled();
  });

  it("ATOMICITY: a batched-record rejection propagates, so the move rolls back", async () => {
    recordActivityEvents.mockRejectedValue(new Error("db down"));
    await expect(
      captureBatchProjectChange({
        tx: TX,
        organizationId: ORG,
        actor: { userId: USER, authMethod: "session" },
        changes: [{ artifactId: "a1", before: "proj-a", after: "proj-b" }],
      })
    ).rejects.toThrow("db down");
    expect(recordActivityEvents).toHaveBeenCalledTimes(1);
  });
});

describe("captureArtifactCreation", () => {
  it("records a creation event with an after snapshot and no before", async () => {
    await captureArtifactCreation({
      tx: TX,
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "api_key" },
      after: { status: "DRAFT", title: "New PRD" },
    });

    expect(recordActivityEvent).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        artifactId: ARTIFACT,
        actorType: ArtifactActivityActorType.Agent,
        actorId: USER,
        action: ArtifactActivityAction.Creation,
        before: null,
        after: { status: "DRAFT", title: "New PRD" },
      },
      TX
    );
  });
});

describe("captureAutomatedUnblock", () => {
  it("attributes the transition to the platform, not to whoever closed the blocker", async () => {
    await captureAutomatedUnblock({
      tx: TX,
      organizationId: ORG,
      changes: [
        { artifactId: "b1", before: "BLOCKED", after: "TODO" },
        { artifactId: "b2", before: "BLOCKED", after: "TODO" },
      ],
    });

    // `system` with a null actorId is what makes an automated unblock
    // distinguishable from a human status change in the feed — a status that
    // moved with no actor and no audit row is indistinguishable from a bug.
    expect(recordActivityEvent).not.toHaveBeenCalled();
    expect(recordActivityEvents).toHaveBeenCalledTimes(1);
    expect(recordActivityEvents).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        events: [
          {
            artifactId: "b1",
            actorType: ArtifactActivityActorType.System,
            actorId: null,
            action: ArtifactActivityAction.StatusChange,
            before: "BLOCKED",
            after: "TODO",
          },
          {
            artifactId: "b2",
            actorType: ArtifactActivityActorType.System,
            actorId: null,
            action: ArtifactActivityAction.StatusChange,
            before: "BLOCKED",
            after: "TODO",
          },
        ],
      },
      TX
    );
  });

  it("records nothing when the sweep moved nothing", async () => {
    await captureAutomatedUnblock({ tx: TX, organizationId: ORG, changes: [] });

    expect(recordActivityEvents).not.toHaveBeenCalled();
  });
});

describe("capture failure reporting", () => {
  /** A receipt failure reports bounded dimensions before it rejects the write. */
  it("reports a lost single-artifact receipt on the monitored event name", async () => {
    recordActivityEvent.mockRejectedValue(new Error("db down"));

    await expect(
      captureArtifactUpdate({
        tx: TX,
        organizationId: ORG,
        artifactId: ARTIFACT,
        actor: { userId: USER, authMethod: "session" },
        before: fields({ status: "DRAFT" }),
        after: fields({ status: "IN_REVIEW" }),
        provenance: { surface: ArtifactStatusEditSurface.Detail },
      })
    ).rejects.toThrow();

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.SingleUpdate,
        organizationId: ORG,
        artifactId: ARTIFACT,
        field: ArtifactFieldEditField.Status,
        surface: ArtifactStatusEditSurface.Detail,
        rolledBackReceiptCount: 1,
      })
    );
  });

  it("reports a lost BATCH receipt with the count of receipts lost", async () => {
    // The count is the operator's blast radius for a batch: one failed insert
    // here is N missing ledger entries, not one.
    recordActivityEvents.mockRejectedValue(new Error("db down"));

    await expect(
      captureBatchStatusChange({
        tx: TX,
        organizationId: ORG,
        actor: { userId: USER, authMethod: "session" },
        changes: [
          { artifactId: "a1", before: "DRAFT", after: "APPROVED" },
          { artifactId: "a2", before: "IN_REVIEW", after: "APPROVED" },
        ],
      })
    ).rejects.toThrow();

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.BatchStatus,
        organizationId: ORG,
        field: ArtifactFieldEditField.Status,
        rolledBackReceiptCount: 2,
      })
    );
  });

  it("stays silent when capture succeeds", async () => {
    // Guards the other direction: an event that fires on the healthy path is a
    // monitor that pages on ordinary traffic.
    await captureArtifactUpdate({
      tx: TX,
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "session" },
      before: fields({ status: "DRAFT" }),
      after: fields({ status: "IN_REVIEW" }),
    });

    expect(logError).not.toHaveBeenCalled();
  });

  /**
   * #7225 review, davetho — the batch-PRIORITY reporter is a second, separate
   * code path with its own stage, and the batch-status case above cannot see
   * it. Without this, deleting the priority path's report leaves the suite
   * green and that alert silently stops existing.
   */
  it("reports a lost batch-PRIORITY receipt under its own stage and count", async () => {
    recordActivityEvents.mockRejectedValue(new Error("db down"));

    await expect(
      captureBatchPriorityChange({
        tx: TX,
        organizationId: ORG,
        actor: { userId: USER, authMethod: "session" },
        changes: [
          { artifactId: "a1", before: "LOW", after: "HIGH" },
          { artifactId: "a2", before: null, after: "URGENT" },
          { artifactId: "a3", before: "HIGH", after: "HIGH" }, // no-op, not counted
        ],
      })
    ).rejects.toThrow();

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.BatchPriority,
        organizationId: ORG,
        // Two moved, not three: the count is the receipts actually lost.
        field: ArtifactFieldEditField.Priority,
        rolledBackReceiptCount: 2,
      })
    );
  });

  /**
   * ISS-9158 — the batch-PROJECT reporter is a third separate path with its
   * own stage; deleting its report would leave the suite green without this.
   */
  it("reports a lost batch-PROJECT receipt under its own stage and count", async () => {
    recordActivityEvents.mockRejectedValue(new Error("db down"));

    await expect(
      captureBatchProjectChange({
        tx: TX,
        organizationId: ORG,
        actor: { userId: USER, authMethod: "session" },
        changes: [
          { artifactId: "a1", before: "proj-a", after: "proj-b" },
          { artifactId: "a2", before: null, after: "proj-b" },
          { artifactId: "a3", before: "proj-b", after: "proj-b" }, // no-op, not counted
        ],
      })
    ).rejects.toThrow();

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.BatchProject,
        organizationId: ORG,
        field: ArtifactFieldEditField.ProjectId,
        rolledBackReceiptCount: 2,
      })
    );
  });

  /**
   * #7225 review, codex — `recordChanges` is shared by the update and creation
   * paths, so a lost creation receipt used to be reported as `single_update`.
   * An operator grouping by the documented closed `stage` label then read a
   * lost feed-opening entry as an ordinary edit failure.
   */
  it("reports a lost CREATION receipt under the creation stage, not single_update", async () => {
    recordActivityEvent.mockRejectedValue(new Error("db down"));

    await expect(
      captureArtifactCreation({
        tx: TX,
        organizationId: ORG,
        artifactId: ARTIFACT,
        actor: { userId: USER, authMethod: "session" },
        after: { status: "DRAFT", title: "New PRD" },
      })
    ).rejects.toThrow();

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.Creation,
        artifactId: ARTIFACT,
      })
    );
  });
});

describe("capture failure emission bound", () => {
  it("keeps grouped lineage for forced board update and priority rollbacks", async () => {
    recordActivityEvent.mockRejectedValueOnce(new Error("db down"));
    await expect(
      captureArtifactUpdate({
        tx: TX,
        organizationId: "org-board-update",
        artifactId: ARTIFACT,
        actor: { userId: USER, authMethod: "session" },
        before: fields({ status: "DRAFT" }),
        after: fields({ status: "IN_REVIEW" }),
        provenance: {
          surface: ArtifactStatusEditSurface.Board,
          commitGroupId: "private-update-group",
        },
      })
    ).rejects.toThrow();

    recordActivityEvents.mockRejectedValueOnce(new Error("db down"));
    await expect(
      captureBatchPriorityChange({
        tx: TX,
        organizationId: "org-board-priority",
        actor: { userId: USER, authMethod: "session" },
        changes: [{ artifactId: ARTIFACT, before: "LOW", after: "HIGH" }],
        provenance: {
          surface: ArtifactStatusEditSurface.Board,
          commitGroupId: "private-priority-group",
        },
        stage: ArtifactActivityCaptureStage.SingleUpdate,
      })
    ).rejects.toThrow();
    await Promise.all(scheduled.splice(0, scheduled.length));

    expect(captureImmediate).toHaveBeenCalledTimes(2);
    for (const [{ distinctId, properties }] of captureImmediate.mock.calls) {
      expect(distinctId).toBe(USER);
      expect(properties).toMatchObject({
        result: ArtifactFieldEditOutcome.RolledBack,
        lineage: ArtifactFieldEditLineage.Grouped,
        surface: ArtifactStatusEditSurface.Board,
      });
      expect(JSON.stringify(properties)).not.toContain("private-");
    }
  });

  /**
   * These capture paths hang off authenticated mutation routes, so while
   * activity persistence is down a caller looping a PUT drives one Datadog
   * event per request — the amplification vector `apps/api/AGENTS.md`
   * ("Emission and Abuse Control") names. The bound is per (org, stage).
   */
  it("emits once per (org, stage) window however many failures arrive", async () => {
    recordActivityEvent.mockRejectedValue(new Error("db down"));

    for (let i = 0; i < 5; i += 1) {
      await expect(
        captureArtifactUpdate({
          tx: TX,
          organizationId: ORG,
          artifactId: `artifact-${i}`,
          actor: { userId: USER, authMethod: "session" },
          before: fields({ status: "DRAFT" }),
          after: fields({ status: "IN_REVIEW" }),
        })
      ).rejects.toThrow();
    }

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({ occurrences: 1 })
    );
  });

  it("does not let one org's burst mute another org's first failure", async () => {
    // The key is (org, stage), not a global gate. A throttle that silenced the
    // whole event during one tenant's outage would hide every other tenant's.
    recordActivityEvent.mockRejectedValue(new Error("db down"));

    for (const org of [ORG, ORG, "org-2"]) {
      await expect(
        captureArtifactUpdate({
          tx: TX,
          organizationId: org,
          artifactId: ARTIFACT,
          actor: { userId: USER, authMethod: "session" },
          before: fields({ status: "DRAFT" }),
          after: fields({ status: "IN_REVIEW" }),
        })
      ).rejects.toThrow();
    }

    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenLastCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({ organizationId: "org-2" })
    );
  });

  it("flushes the suppressed count as a rollup when the window rolls over", async () => {
    // Suppressed is not discarded: `sum(occurrences)` still carries the volume,
    // which is what makes the bound safe to apply to an outage alert. Time is
    // pinned rather than slept — the window is a minute long.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    recordActivityEvent.mockRejectedValue(new Error("db down"));

    async function fail() {
      await expect(
        captureArtifactUpdate({
          tx: TX,
          organizationId: ORG,
          artifactId: ARTIFACT,
          actor: { userId: USER, authMethod: "session" },
          before: fields({ status: "DRAFT" }),
          after: fields({ status: "IN_REVIEW" }),
        })
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
    }

    await fail(); // emits
    await fail(); // suppressed
    await fail(); // suppressed

    vi.setSystemTime(new Date("2026-09-14T00:01:30.000Z"));
    await fail(); // opens a new window and flushes the two it suppressed

    const rollups = logError.mock.calls.filter(
      (call) => (call[1] as { occurrences: number }).occurrences === 2
    );
    expect(rollups).toHaveLength(1);
    expect(rollups[0][1]).toEqual(
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.SingleUpdate,
        organizationId: ORG,
        occurrences: 2,
      })
    );
  });
});

function classified(
  field: string,
  value: string | null,
  valueClassification: ArtifactFieldEditValueClassification
) {
  return { field, value, valueClassification };
}

function committed(
  field: string,
  value: string | null,
  valueClassification: ArtifactFieldEditValueClassification
) {
  return {
    field,
    value,
    valueClassification,
    result: ArtifactStatusCommitResult.Committed,
  };
}
