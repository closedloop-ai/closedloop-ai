/**
 * ISS-9465 — the four post-commit emitters, driven DIRECTLY.
 *
 * The route suites reach these through a service mock that reports an empty
 * change set, so every one of them returns at its `length === 0` guard and no
 * emission is ever executed: deleting an `emit*SideEffects` call leaves those
 * suites green. These cases execute the emission instead, so the audit action,
 * the object type, the transaction stamp and the real-transition filter are
 * each pinned by an assertion that fails when the behaviour changes.
 *
 * PER-EMITTER and, inside `bulk-assign`, PER-ARM. Ruling 6 is a per-route
 * contract and ruling 3 a per-table one; a fixture covering one emitter cannot
 * tell a per-route implementation from one that stamps a single global id, and
 * a fixture covering one arm of `bulk-assign` cannot tell the project arm's
 * action from the owner arm's.
 *
 * Every action and object-type value is a LITERAL, never imported from the
 * const it guards: these strings are hashed into an append-only chain, so a
 * fixture built from the same constant the production path reads agrees with
 * any mistake in it.
 */

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchAuditEvents: vi.fn(),
  captureBatchProjectChange: vi.fn(),
  captureBatchSessionOwnerAssignment: vi.fn(),
  captureBatchTagApplied: vi.fn(),
  captureBatchTagRemoved: vi.fn(),
  captureBatchStatusChange: vi.fn(),
  captureBatchPriorityChange: vi.fn(),
  captureFieldEditAnalytics: vi.fn(),
  unblockDependents: vi.fn(),
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) =>
    mocks.dispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchProjectChange: (...args: unknown[]) =>
    mocks.captureBatchProjectChange(...args),
  captureBatchSessionOwnerAssignment: (...args: unknown[]) =>
    mocks.captureBatchSessionOwnerAssignment(...args),
  captureBatchTagApplied: (...args: unknown[]) =>
    mocks.captureBatchTagApplied(...args),
  captureBatchTagRemoved: (...args: unknown[]) =>
    mocks.captureBatchTagRemoved(...args),
  captureBatchStatusChange: (...args: unknown[]) =>
    mocks.captureBatchStatusChange(...args),
  captureBatchPriorityChange: (...args: unknown[]) =>
    mocks.captureBatchPriorityChange(...args),
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
    resolveBlocksForChangedArtifacts: (...args: unknown[]) =>
      mocks.unblockDependents(...args),
  },
}));

import {
  captureBulkAssignActivity,
  emitBulkAssignSideEffects,
} from "@/app/agent-sessions/bulk-assign-side-effects";
import { AgentSessionBulkAssignField } from "@/app/agent-sessions/write-contract";
import { dispatchSingleArtifactMutationAudits } from "@/app/audit/single-artifact-mutation-audit";
import {
  captureBatchPriorityActivity,
  emitBatchPrioritySideEffects,
} from "@/app/documents/batch-priority-side-effects";
import {
  captureBatchStatusActivity,
  emitBatchStatusSideEffects,
} from "@/app/documents/batch-status-side-effects";
import {
  captureBatchTagActivity,
  emitBatchTagSideEffects,
} from "@/app/tags/batch-tag-side-effects";
import {
  captureBatchMoveActivity,
  emitBatchMoveSideEffects,
} from "@/lib/batch-move-side-effects";

/**
 * The mutation's transaction client (ISS-10993). Opaque — the store is mocked,
 * so nothing calls a method on it; what the receipt assertions pin is that the
 * client the caller owns is what reaches the capture.
 */
const TX = { __brand: "tx" } as unknown as TransactionClient;

const USER = { id: "user-1", organizationId: "org-1" };
const AUTH = "session" as const;
const TXN = "11111111-1111-4111-8111-111111111111";
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ARTIFACT_PROJECT_CHANGED = "artifact.project_changed";
const ARTIFACT_TAG_APPLIED = "artifact.tag_applied";
const ARTIFACT_TAG_REMOVED = "artifact.tag_removed";
const AGENT_SESSION_ASSIGNED = "agent_session.assigned";
const DOCUMENT_PRIORITY_CHANGED = "document.priority_changed";
const DOCUMENT_STATUS_CHANGED = "document.status_changed";
const ARTIFACT_OBJECT = "artifact";
const AGENT_SESSION_OBJECT = "agent_session";
const DOCUMENT_OBJECT = "document";

type Emission = {
  action: string;
  objectType: string;
  objectId: string;
  detail: Record<string, unknown>;
};

function emitted(): Emission[] {
  return mocks.dispatchAuditEvents.mock.calls[0][0] as Emission[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitBatchMoveSideEffects", () => {
  it("writes one artifact.project_changed entry per moved row, stamped", () => {
    emitBatchMoveSideEffects({
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
        { artifactId: ROW_B, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
    });

    expect(emitted()).toHaveLength(2);
    expect(emitted()[0]).toMatchObject({
      action: ARTIFACT_PROJECT_CHANGED,
      objectType: ARTIFACT_OBJECT,
      objectId: ROW_A,
      detail: { from: "proj-1", to: "proj-2", transactionId: TXN },
    });
  });

  it("drops a row already in the target project from BOTH halves", () => {
    // The audit-side filter has no coverage of its own; without it the ledger
    // gains a permanent entry for a row that never moved.
    emitBatchMoveSideEffects({
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-2", after: "proj-2" },
        { artifactId: ROW_B, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
    });

    expect(emitted().map((event) => event.objectId)).toEqual([ROW_B]);

    // The receipt half now commits with the move, so it is driven through its
    // own entry point — with the SAME input, which is what makes "BOTH halves"
    // still mean one set of rows.
    captureBatchMoveActivity(TX, {
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-2", after: "proj-2" },
        { artifactId: ROW_B, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
      surface: ArtifactStatusEditSurface.Bulk,
    });
    expect(mocks.captureBatchProjectChange).toHaveBeenCalledWith({
      tx: TX,
      organizationId: USER.organizationId,
      actor: { userId: USER.id, authMethod: AUTH },
      changes: [{ artifactId: ROW_B, before: "proj-1", after: "proj-2" }],
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TXN,
      },
      transactionId: TXN,
    });
  });

  it("omits receipt provenance when a version-skewed surface is unknown", () => {
    captureBatchMoveActivity(TX, {
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
    });

    expect(mocks.captureBatchProjectChange).toHaveBeenCalledWith({
      tx: TX,
      organizationId: USER.organizationId,
      actor: { userId: USER.id, authMethod: AUTH },
      changes: [{ artifactId: ROW_A, before: "proj-1", after: "proj-2" }],
      provenance: undefined,
      preserveProvenanceOmission: true,
      transactionId: TXN,
    });
  });
});

describe("emitBulkAssignSideEffects", () => {
  it("audits the PROJECT arm as a project change, like every other move", () => {
    emitBulkAssignSideEffects({
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Project,
      changes: [{ artifactId: ROW_A, before: "proj-1", after: "proj-2" }],
      transactionId: TXN,
    });

    expect(emitted()[0]).toMatchObject({
      action: ARTIFACT_PROJECT_CHANGED,
      objectType: ARTIFACT_OBJECT,
    });

    captureBulkAssignActivity(TX, {
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Project,
      changes: [{ artifactId: ROW_A, before: "proj-1", after: "proj-2" }],
      transactionId: TXN,
    });
    expect(mocks.captureBatchProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({ tx: TX, transactionId: TXN })
    );
    expect(mocks.captureBatchSessionOwnerAssignment).not.toHaveBeenCalled();
  });

  it("audits the OWNER arm as a session assignment", () => {
    emitBulkAssignSideEffects({
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Owner,
      changes: [{ artifactId: ROW_A, before: null, after: "user-9" }],
      transactionId: TXN,
    });

    expect(emitted()[0]).toMatchObject({
      action: AGENT_SESSION_ASSIGNED,
      objectType: AGENT_SESSION_OBJECT,
      detail: { from: null, to: "user-9", transactionId: TXN },
    });
    captureBulkAssignActivity(TX, {
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Owner,
      changes: [{ artifactId: ROW_A, before: null, after: "user-9" }],
      transactionId: TXN,
    });
    expect(mocks.captureBatchSessionOwnerAssignment).toHaveBeenCalledWith({
      tx: TX,
      organizationId: USER.organizationId,
      actor: { userId: USER.id, authMethod: AUTH },
      changes: [{ artifactId: ROW_A, before: null, after: "user-9" }],
      transactionId: TXN,
    });
    expect(mocks.captureBatchProjectChange).not.toHaveBeenCalled();
  });

  it("writes nothing when every requested session already held the target", () => {
    emitBulkAssignSideEffects({
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Owner,
      changes: [{ artifactId: ROW_A, before: "user-9", after: "user-9" }],
      transactionId: TXN,
    });

    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
    expect(mocks.captureBatchSessionOwnerAssignment).not.toHaveBeenCalled();
  });
});

describe("emitBatchTagSideEffects", () => {
  it("writes one entry per artifact that GAINED the tag", () => {
    emitBatchTagSideEffects({
      user: USER,
      authMethod: AUTH,
      action: ARTIFACT_TAG_APPLIED,
      tagId: "tag-1",
      changedIds: [ROW_B],
      transactionId: TXN,
    });

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({
      action: ARTIFACT_TAG_APPLIED,
      objectType: ARTIFACT_OBJECT,
      objectId: ROW_B,
      detail: { tagId: "tag-1", transactionId: TXN },
    });
  });
});

describe("emitBatchPrioritySideEffects", () => {
  it("writes one document.priority_changed entry per changed id, stamped", () => {
    emitBatchPrioritySideEffects({
      user: USER,
      authMethod: AUTH,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.Bulk,
      changedIds: [ROW_A],
      beforePriorities: new Map([[ROW_A, Priority.Low]]),
      transactionId: TXN,
    });

    expect(emitted()[0]).toMatchObject({
      action: DOCUMENT_PRIORITY_CHANGED,
      objectType: DOCUMENT_OBJECT,
      objectId: ROW_A,
      detail: { from: Priority.Low, to: Priority.Urgent, transactionId: TXN },
    });
  });
});

describe("emitBatchStatusSideEffects — ruling 3", () => {
  it("stamps the transaction id and no longer carries the `batch` flag", async () => {
    // Ruling 3 REPLACED `batch: true` with the transaction id. Without this
    // case, re-adding the boolean — two overlapping signals in an append-only
    // hash-chained table that can never be reconciled — is green everywhere.
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

    const entry = emitted()[0];
    expect(entry).toMatchObject({
      action: DOCUMENT_STATUS_CHANGED,
      objectType: DOCUMENT_OBJECT,
      objectId: ROW_A,
    });
    expect(entry.detail.transactionId).toBe(TXN);
    expect(entry.detail).not.toHaveProperty("batch");
  });
});

describe("one action, one detail shape", () => {
  it("bulk-assign's PROJECT arm writes the move emitter's detail, key for key", () => {
    // Both emitters write `artifact.project_changed`, so an operator querying
    // that one action must get one row shape back whichever route produced it.
    // `field` used to ride only on the bulk-assign side, permanently, in a
    // hash-chained table where a shape cannot be corrected later.
    emitBulkAssignSideEffects({
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Project,
      changes: [{ artifactId: ROW_A, before: "proj-1", after: "proj-2" }],
      transactionId: TXN,
    });
    const fromAssign = emitted()[0];

    mocks.dispatchAuditEvents.mockClear();
    emitBatchMoveSideEffects({
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
    });
    const fromMove = emitted()[0];

    expect(fromAssign.action).toBe(fromMove.action);
    expect(fromAssign.detail).toEqual(fromMove.detail);
  });
});

describe("ISS-10681 AC-006 and AC-007 single and bulk audit parity", () => {
  it("pins priority action, object, and detail independently for both producers", () => {
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [
        {
          action: DOCUMENT_PRIORITY_CHANGED,
          objectId: ROW_A,
          before: Priority.Low,
          after: Priority.Urgent,
        },
      ],
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "document.priority_changed",
        objectType: "document",
        objectId: ROW_A,
        detail: { from: Priority.Low, to: Priority.Urgent },
      },
    ]);

    mocks.dispatchAuditEvents.mockClear();
    emitBatchPrioritySideEffects({
      user: USER,
      authMethod: AUTH,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.Bulk,
      changedIds: [ROW_A],
      beforePriorities: new Map([[ROW_A, Priority.Low]]),
      transactionId: TXN,
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "document.priority_changed",
        objectType: "document",
        objectId: ROW_A,
        detail: {
          from: Priority.Low,
          to: Priority.Urgent,
          transactionId: TXN,
        },
      },
    ]);
  });

  it("pins project action, object, and detail independently for both producers", () => {
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [
        {
          action: ARTIFACT_PROJECT_CHANGED,
          objectId: ROW_A,
          before: "proj-1",
          after: "proj-2",
        },
      ],
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.project_changed",
        objectType: "artifact",
        objectId: ROW_A,
        detail: { from: "proj-1", to: "proj-2" },
      },
    ]);

    mocks.dispatchAuditEvents.mockClear();
    emitBatchMoveSideEffects({
      user: USER,
      authMethod: AUTH,
      projectChanges: [
        { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
      ],
      transactionId: TXN,
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.project_changed",
        objectType: "artifact",
        objectId: ROW_A,
        detail: { from: "proj-1", to: "proj-2", transactionId: TXN },
      },
    ]);
  });

  it("pins tag action, object, and detail independently for both producers", () => {
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [
        {
          action: ARTIFACT_TAG_APPLIED,
          objectId: ROW_A,
          tagId: "tag-1",
        },
      ],
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.tag_applied",
        objectType: "artifact",
        objectId: ROW_A,
        detail: { tagId: "tag-1" },
      },
    ]);

    mocks.dispatchAuditEvents.mockClear();
    emitBatchTagSideEffects({
      user: USER,
      authMethod: AUTH,
      action: ARTIFACT_TAG_APPLIED,
      tagId: "tag-1",
      changedIds: [ROW_A],
      transactionId: TXN,
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.tag_applied",
        objectType: "artifact",
        objectId: ROW_A,
        detail: { tagId: "tag-1", transactionId: TXN },
      },
    ]);
  });

  it("pins tag-removal action, object, and detail independently for both producers", () => {
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [
        {
          action: ARTIFACT_TAG_REMOVED,
          objectId: ROW_A,
          tagId: "tag-1",
        },
      ],
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.tag_removed",
        objectType: "artifact",
        objectId: ROW_A,
        detail: { tagId: "tag-1" },
      },
    ]);

    mocks.dispatchAuditEvents.mockClear();
    emitBatchTagSideEffects({
      user: USER,
      authMethod: AUTH,
      action: ARTIFACT_TAG_REMOVED,
      tagId: "tag-1",
      changedIds: [ROW_A],
      transactionId: TXN,
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.tag_removed",
        objectType: "artifact",
        objectId: ROW_A,
        detail: { tagId: "tag-1", transactionId: TXN },
      },
    ]);
  });

  it("pins assignment action, object, and detail independently for both producers", () => {
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [
        {
          action: AGENT_SESSION_ASSIGNED,
          objectId: ROW_A,
          before: null,
          after: "user-9",
        },
      ],
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "agent_session.assigned",
        objectType: "agent_session",
        objectId: ROW_A,
        detail: { from: null, to: "user-9" },
      },
    ]);

    mocks.dispatchAuditEvents.mockClear();
    emitBulkAssignSideEffects({
      user: USER,
      authMethod: AUTH,
      field: AgentSessionBulkAssignField.Owner,
      changes: [{ artifactId: ROW_A, before: null, after: "user-9" }],
      transactionId: TXN,
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "agent_session.assigned",
        objectType: "agent_session",
        objectId: ROW_A,
        detail: { from: null, to: "user-9", transactionId: TXN },
      },
    ]);
  });

  it("AC-006 batches mixed real changes and filters transition no-ops", () => {
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [
        {
          action: DOCUMENT_PRIORITY_CHANGED,
          objectId: ROW_A,
          before: Priority.Low,
          after: Priority.Low,
        },
        {
          action: ARTIFACT_PROJECT_CHANGED,
          objectId: ROW_A,
          before: "proj-1",
          after: "proj-2",
        },
        {
          action: AGENT_SESSION_ASSIGNED,
          objectId: ROW_A,
          before: "user-9",
          after: "user-9",
        },
        {
          action: ARTIFACT_TAG_APPLIED,
          objectId: ROW_B,
          tagId: "tag-1",
        },
      ],
    });

    expect(emitted()).toEqual([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.project_changed",
        objectType: "artifact",
        objectId: ROW_A,
        detail: { from: "proj-1", to: "proj-2" },
      },
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: "artifact.tag_applied",
        objectType: "artifact",
        objectId: ROW_B,
        detail: { tagId: "tag-1" },
      },
    ]);
  });

  it("AC-005 isolates a failed single ledger dispatch from the committed mutation", () => {
    mocks.dispatchAuditEvents.mockImplementation(() => {
      throw new Error("waitUntil rejected");
    });

    expect(() =>
      dispatchSingleArtifactMutationAudits({
        organizationId: USER.organizationId,
        userId: USER.id,
        changes: [
          {
            action: DOCUMENT_PRIORITY_CHANGED,
            objectId: ROW_A,
            before: Priority.Low,
            after: Priority.Urgent,
          },
        ],
      })
    ).not.toThrow();
  });

  it("AC-006 does not call the ledger for an empty or all-no-op set", () => {
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [],
    });
    dispatchSingleArtifactMutationAudits({
      organizationId: USER.organizationId,
      userId: USER.id,
      changes: [
        {
          action: ARTIFACT_PROJECT_CHANGED,
          objectId: ROW_A,
          before: "proj-1",
          after: "proj-1",
        },
      ],
    });

    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
  });
});

describe("a failed ledger dispatch never rethrows into a committed batch", () => {
  // A throwing `dispatchAuditEvents` stands in for the one synchronous failure
  // these paths have after the batch committed: `waitUntil` rejecting at the
  // request-context boundary. The emitter must not rethrow — that would 500 a
  // committed batch and let the client's retry reapply the mutation.
  //
  // ISS-10993 removed the other half these cases used to pin: the activity
  // receipt is no longer emitted here at all, so it cannot be skipped by this
  // failure. Its own coverage is the `capture*Activity` describe below.
  beforeEach(() => {
    mocks.dispatchAuditEvents.mockImplementation(() => {
      throw new Error("waitUntil rejected");
    });
  });

  it("emitBatchMoveSideEffects", () => {
    expect(() =>
      emitBatchMoveSideEffects({
        user: USER,
        authMethod: AUTH,
        projectChanges: [
          { artifactId: ROW_A, before: "proj-1", after: "proj-2" },
        ],
        transactionId: TXN,
      })
    ).not.toThrow();
  });

  it("emitBulkAssignSideEffects", () => {
    expect(() =>
      emitBulkAssignSideEffects({
        user: USER,
        authMethod: AUTH,
        field: AgentSessionBulkAssignField.Owner,
        changes: [{ artifactId: ROW_A, before: null, after: "user-9" }],
        transactionId: TXN,
      })
    ).not.toThrow();
  });

  it("emitBatchTagSideEffects", () => {
    expect(() =>
      emitBatchTagSideEffects({
        user: USER,
        authMethod: AUTH,
        action: ARTIFACT_TAG_APPLIED,
        tagId: "tag-1",
        changedIds: [ROW_B],
        transactionId: TXN,
      })
    ).not.toThrow();
  });

  it("emitBatchPrioritySideEffects", () => {
    expect(() =>
      emitBatchPrioritySideEffects({
        user: USER,
        authMethod: AUTH,
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Bulk,
        changedIds: [ROW_A],
        beforePriorities: new Map([[ROW_A, Priority.Low]]),
        transactionId: TXN,
      })
    ).not.toThrow();
    expect(mocks.dispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledTimes(1);
  });

  it("emitBatchStatusSideEffects", async () => {
    await expect(
      emitBatchStatusSideEffects({
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
      })
    ).resolves.toBeUndefined();
    // The dependent-unblock sweep runs last; a rethrow from the dispatch above
    // would have skipped it.
    expect(mocks.unblockDependents).toHaveBeenCalled();
    expect(mocks.dispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-10993 — the receipt half, at its new owner. Each of these runs inside the
 * mutation's transaction and REJECTS on failure, so the write rolls back with
 * it. The emitters above can no longer skip a receipt, because they no longer
 * write one.
 */
describe("capture*Activity writes its receipt on the caller's transaction", () => {
  it("captureBatchStatusActivity", async () => {
    await captureBatchStatusActivity(TX, {
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

    expect(mocks.captureBatchStatusChange).toHaveBeenCalledWith({
      tx: TX,
      organizationId: USER.organizationId,
      actor: { userId: USER.id, authMethod: AUTH },
      changes: [
        {
          artifactId: ROW_A,
          before: IssueStatus.Todo,
          after: IssueStatus.Done,
        },
      ],
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TXN,
      },
      transactionId: TXN,
      undoOfTransactionId: undefined,
    });
  });

  it("captureBatchPriorityActivity preserves omitted provenance", async () => {
    await captureBatchPriorityActivity(TX, {
      user: USER,
      authMethod: AUTH,
      priority: Priority.Urgent,
      surface: undefined,
      changedIds: [ROW_A],
      beforePriorities: new Map([[ROW_A, Priority.Low]]),
      transactionId: TXN,
    });

    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledWith({
      tx: TX,
      organizationId: USER.organizationId,
      actor: { userId: USER.id, authMethod: AUTH },
      changes: [
        { artifactId: ROW_A, before: Priority.Low, after: Priority.Urgent },
      ],
      provenance: undefined,
      preserveProvenanceOmission: true,
      transactionId: TXN,
    });
  });

  it("captureBatchPriorityActivity", async () => {
    await captureBatchPriorityActivity(TX, {
      user: USER,
      authMethod: AUTH,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.Bulk,
      changedIds: [ROW_A],
      beforePriorities: new Map([[ROW_A, Priority.Low]]),
      transactionId: TXN,
    });

    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledWith({
      tx: TX,
      organizationId: USER.organizationId,
      actor: { userId: USER.id, authMethod: AUTH },
      changes: [
        { artifactId: ROW_A, before: Priority.Low, after: Priority.Urgent },
      ],
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TXN,
      },
      preserveProvenanceOmission: true,
      transactionId: TXN,
    });
  });

  it("captureBatchTagActivity", async () => {
    await captureBatchTagActivity(TX, {
      user: USER,
      authMethod: AUTH,
      action: ARTIFACT_TAG_APPLIED,
      tagId: "tag-1",
      changedIds: [ROW_B],
      transactionId: TXN,
    });

    expect(mocks.captureBatchTagApplied).toHaveBeenCalledWith(
      expect.objectContaining({ tx: TX, transactionId: TXN })
    );
  });

  it("a failing receipt REJECTS, so the mutation rolls back", async () => {
    mocks.captureBatchTagApplied.mockRejectedValue(new Error("store down"));

    await expect(
      captureBatchTagActivity(TX, {
        user: USER,
        authMethod: AUTH,
        action: ARTIFACT_TAG_APPLIED,
        tagId: "tag-1",
        changedIds: [ROW_B],
        transactionId: TXN,
      })
    ).rejects.toThrow("store down");
  });
});
