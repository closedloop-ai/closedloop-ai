/**
 * `createSession` / `updateSession` (ISS-8648), including the index-key parity
 * the write path inherits from the desktop ingest.
 *
 * `bulkAssignSessions` lives in the sibling
 * `session-write-service.bulk-assign.test.ts`; both drive the same transaction
 * double at `@/__tests__/support/agent-sessions/session-write-service.test-mocks`.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactFieldEditField } from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import { Status } from "@repo/api/src/types/result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SessionOrigin } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_ID,
  COMPUTE_TARGET_ID,
  DELETED_SESSION,
  FOREIGN_COMPUTE_TARGET_ID,
  FOREIGN_OWNER_ID,
  FOREIGN_PROJECT_ID,
  FOREIGN_SESSION,
  listRow,
  mocks,
  NON_SESSION_ARTIFACT,
  ORG_ID,
  OTHER_ORG_ID,
  OWNER_ID,
  PROJECT_ID,
  resetSessionWriteMocks,
  SESSION_A,
  SESSION_B,
  tx,
} from "@/__tests__/support/agent-sessions/session-write-service.test-mocks";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import {
  INDEX_KEY_MAX_BYTES,
  INDEX_KEY_PROJECTION_MARKER,
  projectIndexKey,
} from "@/lib/index-key-projection";

vi.mock("@repo/database", () => ({
  // Both members, so an `origin` assertion below is decided by WHICH one
  // production picked rather than by the mock having only one to give.
  SessionOrigin: { DESKTOP_SYNC: "DESKTOP_SYNC", LOOP: "LOOP" },
  // Enough of the tagged-template builder for the fake to read back WHICH
  // table a locking read named and WHICH rows it bound. Kept structural rather
  // than string-rendering: the double asserts on the bindings, so a statement
  // that stopped binding the org would have nothing to match.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    join: (values: unknown[]) => ({ strings: [], values }),
  },
  withDb: Object.assign(
    vi.fn((callback: (db: typeof tx) => unknown) => callback(tx)),
    {
      // A Prisma interactive transaction commits when its callback RESOLVES and
      // rolls back only when it THROWS. Recording which way the callback
      // settled is how these tests prove "nothing was applied" at a mocked
      // seam: a refusal that returned instead of throwing would leave
      // `txRolledBack` false while the earlier `updateMany` stayed committed.
      tx: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (error) {
          mocks.txRolledBack = true;
          throw error;
        }
      }),
    }
  ),
}));

vi.mock("./service/list-by-artifact-ids", () => ({
  listSessionsByArtifactIds: mocks.listSessionsByArtifactIds,
}));

vi.mock("./service/advisory-locks", () => ({
  acquireSessionAdvisoryLocks: mocks.acquireSessionAdvisoryLocks,
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: mocks.generateSlug,
}));

const captureSessionGroupingChanges = vi.hoisted(() => vi.fn());
const emitSessionGroupingAnalytics = vi.hoisted(() => vi.fn());
const dispatchSingleArtifactMutationAudits = vi.hoisted(() => vi.fn());
vi.mock("@/lib/artifact-field-edit-capture", () => ({
  captureSessionGroupingChanges,
}));

vi.mock("./session-field-edit-analytics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitSessionGroupingAnalytics,
}));

vi.mock("@/app/audit/single-artifact-mutation-audit", () => ({
  dispatchSingleArtifactMutationAudits,
}));

vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: { updateAssigneeAfterCommit: vi.fn() },
}));

import { sessionWriteService } from "./session-write-service";

beforeEach(() => {
  resetSessionWriteMocks();
  emitSessionGroupingAnalytics.mockReset();
});

describe("createSession (ISS-8648)", () => {
  it("creates an org-scoped session and returns the LIST projection row", async () => {
    const result = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
      name: "inline created",
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
    });

    expect(result).toEqual({
      ok: true,
      value: { session: listRow(SESSION_A), created: true },
    });
    const data = mocks.sessionDetailCreate.mock.calls[0][0].data;
    // ISS-8515: this transaction has NO cost writer — pre-registration carries no
    // token evidence and no `sessionAnalytics`, so the authoritative patch never
    // corrects this row. Before ISS-8515 the column was omitted and the schema
    // `@default(0)` made it a confident $0. Asserted as an explicit `null` key,
    // not merely "not 0": after the DEFAULT is dropped an omission would reach the
    // same value by accident, and this pins that it is on purpose.
    expect(data).toHaveProperty("estimatedCost");
    expect(data.estimatedCost).toBeNull();
    expect(data.metadataActivityCoverageStartedAt).toBeInstanceOf(Date);
    expect(data.artifact.create).toMatchObject({
      organization: { connect: { id: ORG_ID } },
      project: { connect: { id: PROJECT_ID } },
      type: ArtifactType.Session,
      name: "inline created",
      status: SESSION_STATUS.ACTIVE,
    });
    // ISS-12251 D-1: the Owner is the artifact assignee. ISS-12592: the retired
    // `session_detail.user_id` is not written.
    expect(data.artifact.create.assignee).toEqual({
      connect: { id: OWNER_ID },
    });
    expect(data).not.toHaveProperty("user");
    // NOT NULL columns the ingest also maintains — seeded at the session start
    // so a later desktop sync is never asked to move the anchor backward.
    expect(data.lastActivityAt).toEqual(data.sessionStartedAt);
  });

  it("is idempotent on (computeTargetId, externalSessionId)", async () => {
    mocks.existingSessionDetail = { artifactId: SESSION_B };

    const result = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
    });

    expect(result).toEqual({
      ok: true,
      value: { session: listRow(SESSION_B), created: false },
    });
    expect(mocks.sessionDetailCreate).not.toHaveBeenCalled();
  });

  it("takes the per-session advisory lock BEFORE looking the row up", async () => {
    // The lookup-then-create is only atomic because the ingest's own lock
    // (same key) is held first. A lock taken after the lookup, or not at all,
    // leaves two concurrent writers of this identity both passing the lookup.
    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-lock",
    });

    expect(mocks.acquireSessionAdvisoryLocks).toHaveBeenCalledWith(
      expect.anything(),
      "ext-lock",
      // ISS-8200 (review): the origin is REQUIRED now, and this route genuinely
      // holds a raw wire id. Pinning it is what stops a later edit from sending
      // a column-read value down the wire path unnoticed.
      IndexKeyOrigin.Wire
    );
    expect(mocks.callOrder.indexOf("advisory-lock")).toBeLessThan(
      mocks.callOrder.indexOf("existing-lookup")
    );
    expect(mocks.callOrder.indexOf("existing-lookup")).toBeLessThan(
      mocks.callOrder.indexOf("create")
    );
  });

  it("still returns the existing row when a retry names a project that has since gone", async () => {
    // The idempotency promise must outlive a stale peripheral reference: a
    // retry carrying a now-deleted project has to hand back the existing row,
    // not 400. The same payload on a NON-existing row is still refused.
    mocks.existingSessionDetail = { artifactId: SESSION_B };
    const retry = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
      projectId: FOREIGN_PROJECT_ID,
    });
    expect(retry).toEqual({
      ok: true,
      value: { session: listRow(SESSION_B), created: false },
    });
    expect(mocks.callOrder).not.toContain("project-target-check");

    mocks.existingSessionDetail = null;
    const firstAttempt = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
      projectId: FOREIGN_PROJECT_ID,
    });
    expect(firstAttempt).toEqual({ ok: false, error: Status.BadRequest });
  });

  it("routes the response through the canonical list projection", async () => {
    // The "renderable without a refetch" claim is only true if the row comes
    // from `listSessionsByArtifactIds` — the same projection the Sessions list
    // reads — rather than a shape assembled here.
    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
    });

    expect(mocks.listSessionsByArtifactIds).toHaveBeenCalledWith(
      ORG_ID,
      [SESSION_A],
      1
    );
  });

  it("stamps the DESKTOP_SYNC origin the reaper scopes to", async () => {
    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
    });

    expect(mocks.sessionDetailCreate.mock.calls[0][0].data.origin).toBe(
      SessionOrigin.DESKTOP_SYNC
    );
  });

  it("refuses a compute target in another org, and accepts the org's own", async () => {
    const refused = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: FOREIGN_COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
    });
    expect(refused).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.sessionDetailCreate).not.toHaveBeenCalled();

    const allowed = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
    });
    expect(allowed.ok).toBe(true);
  });

  it("refuses a project or owner in another org", async () => {
    const badProject = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
      projectId: FOREIGN_PROJECT_ID,
    });
    expect(badProject).toEqual({ ok: false, error: Status.BadRequest });

    const badOwner = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-1",
      ownerUserId: FOREIGN_OWNER_ID,
    });
    expect(badOwner).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.sessionDetailCreate).not.toHaveBeenCalled();
  });

  it("falls back to the external id for a name and omits absent optionals", async () => {
    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-9",
    });

    const data = mocks.sessionDetailCreate.mock.calls[0][0].data;
    expect(data.artifact.create.name).toBe("ext-9");
    expect(data.artifact.create.project).toBeUndefined();
    // No `ownerUserId`, no Owner: the actor is never substituted (ISS-12251).
    expect(data.artifact.create).not.toHaveProperty("assignee");
    expect(data.artifact.create.createdBy).toEqual({
      connect: { id: ACTOR_ID },
    });
    expect(data.user).toBeUndefined();
    expect(data.harness).toBeUndefined();
    expect(data.repositoryFullName).toBeUndefined();
  });
});

describe("createSession — index-key parity with the desktop ingest", () => {
  /** Over `INDEX_KEY_MAX_BYTES`, so the projection actually binds. */
  const LONG_EXTERNAL_ID = `run-${"a".repeat(INDEX_KEY_MAX_BYTES)}`;

  it("stores an over-long id PROJECTED, and looks it up under both keys", async () => {
    // ISS-8069. `external_session_id` is half of a UNIQUE btree, so a raw
    // over-long value cannot store at all. The ingest projects it at the column;
    // a create that wrote the raw value would throw where the ingest succeeds.
    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: LONG_EXTERNAL_ID,
    });

    const projected = projectIndexKey(LONG_EXTERNAL_ID);
    expect(projected.projected).toBe(true);
    expect(
      mocks.sessionDetailCreate.mock.calls[0][0].data.externalSessionId
    ).toBe(projected.value);
    // Projected key FIRST, then the raw one — a row written before ISS-8069
    // still sits under the raw value, and missing it mints a second session.
    expect(mocks.lookedUpExternalKeys).toEqual([
      projected.value,
      LONG_EXTERNAL_ID,
    ]);
    // The caller's own id is still what a human sees on the row.
    expect(
      mocks.sessionDetailCreate.mock.calls[0][0].data.artifact.create.name
    ).toBe(LONG_EXTERNAL_ID);
  });

  it("adopts a legacy row stored under the RAW over-long id instead of minting a second", async () => {
    mocks.existingSessionDetail = { artifactId: SESSION_B };
    mocks.existingStoredExternalKey = LONG_EXTERNAL_ID;

    const result = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: LONG_EXTERNAL_ID,
    });

    expect(result).toEqual({
      ok: true,
      value: { session: listRow(SESSION_B), created: false },
    });
    expect(mocks.sessionDetailCreate).not.toHaveBeenCalled();
  });

  it("never stores a reserved-namespace id raw, and never offers it back as a candidate", async () => {
    // ISS-8254. This value IS some long id's projected output. Stored verbatim
    // it would occupy that id's stored key, and the next desktop sync of the
    // real session would join the two runs onto one row. `indexKeyCandidates`
    // must therefore offer only the projection OF this value, never the value.
    const replayed = projectIndexKey(LONG_EXTERNAL_ID).value;
    expect(replayed).toContain(INDEX_KEY_PROJECTION_MARKER);

    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: replayed,
    });

    expect(mocks.lookedUpExternalKeys).not.toContain(replayed);
    const stored =
      mocks.sessionDetailCreate.mock.calls[0][0].data.externalSessionId;
    expect(stored).not.toBe(replayed);
    expect(stored).toBe(projectIndexKey(replayed).value);
  });
});

describe("updateSession (ISS-8648)", () => {
  it("updates an owned session and returns the refreshed row", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
      surface: ArtifactStatusEditSurface.Detail,
    });

    expect(result).toEqual({
      ok: true,
      value: { session: listRow(SESSION_A) },
    });
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: SESSION_A,
        organizationId: ORG_ID,
        type: ArtifactType.Session,
      },
      data: { status: SESSION_STATUS.INACTIVE },
    });
    expect(captureSessionGroupingChanges).toHaveBeenCalledWith({
      tx,
      organizationId: ORG_ID,
      artifactId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      before: {
        status: SESSION_STATUS.ACTIVE,
        projectId: null,
        ownerUserId: null,
      },
      after: {
        status: SESSION_STATUS.INACTIVE,
        projectId: undefined,
        ownerUserId: undefined,
      },
      provenance: { surface: ArtifactStatusEditSurface.Detail },
    });
    expect(emitSessionGroupingAnalytics).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "test-actor",
      changes: [
        {
          field: ArtifactFieldEditField.Status,
          before: SESSION_STATUS.ACTIVE,
          after: SESSION_STATUS.INACTIVE,
        },
      ],
      provenance: { surface: ArtifactStatusEditSurface.Detail },
    });
    expect(dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "test-actor",
      changes: [],
    });
  });

  it("ISS-10681 AC-002 audits a single Session project assignment", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: ACTOR_ID, authMethod: "session" },
      projectId: PROJECT_ID,
    });

    expect(result.ok).toBe(true);
    expect(dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: ACTOR_ID,
      changes: [
        {
          action: AuditAction.ArtifactProjectChanged,
          objectId: SESSION_A,
          before: null,
          after: PROJECT_ID,
        },
      ],
    });
  });

  it("ISS-10681 AC-004 audits a single Session Owner assignment", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: ACTOR_ID, authMethod: "session" },
      ownerUserId: OWNER_ID,
    });

    expect(result.ok).toBe(true);
    expect(dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: ACTOR_ID,
      changes: [
        {
          action: AuditAction.AgentSessionAssigned,
          objectId: SESSION_A,
          before: null,
          after: OWNER_ID,
        },
      ],
    });
  });

  it("ISS-10681 AC-002 and AC-004 batches project and Owner changes after one commit", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: ACTOR_ID, authMethod: "session" },
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
    });

    expect(result.ok).toBe(true);
    expect(dispatchSingleArtifactMutationAudits).toHaveBeenCalledTimes(1);
    expect(dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: ACTOR_ID,
      changes: [
        {
          action: AuditAction.ArtifactProjectChanged,
          objectId: SESSION_A,
          before: null,
          after: PROJECT_ID,
        },
        {
          action: AuditAction.AgentSessionAssigned,
          objectId: SESSION_A,
          before: null,
          after: OWNER_ID,
        },
      ],
    });
  });

  it("ISS-10681 AC-002 and AC-004 sends no changes for same-value assignments", async () => {
    mocks.lockedArtifactRowById.set(SESSION_A, {
      status: SESSION_STATUS.ACTIVE,
      projectId: PROJECT_ID,
    });
    mocks.ownerIdBySession.set(SESSION_A, OWNER_ID);

    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: ACTOR_ID, authMethod: "session" },
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
    });

    expect(result.ok).toBe(true);
    expect(dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: ACTOR_ID,
      changes: [],
    });
  });

  it("404s on a session in another org, where the same call succeeds for its owner", async () => {
    const refused = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: FOREIGN_SESSION,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
    });
    expect(refused).toEqual({ ok: false, error: Status.NotFound });
    expect(dispatchSingleArtifactMutationAudits).not.toHaveBeenCalled();

    const allowed = await sessionWriteService.updateSession({
      organizationId: OTHER_ORG_ID,
      sessionId: FOREIGN_SESSION,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
    });
    expect(allowed.ok).toBe(true);
  });

  it("404s on a row that no longer exists rather than reporting a silent no-op", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: DELETED_SESSION,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(emitSessionGroupingAnalytics).not.toHaveBeenCalled();
  });

  it("writes a status and an owner together in the one artifact write", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
      ownerUserId: OWNER_ID,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactUpdateMany.mock.calls[0][0].data).toEqual({
      status: SESSION_STATUS.INACTIVE,
      assigneeId: OWNER_ID,
    });
  });

  it("treats an absent projectId as leave-alone and an explicit null as unassign", async () => {
    await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
    });
    expect(mocks.artifactUpdateMany.mock.calls[0][0].data).toEqual({
      status: SESSION_STATUS.INACTIVE,
    });

    mocks.lockedArtifactRowById.set(SESSION_A, {
      status: SESSION_STATUS.INACTIVE,
      projectId: PROJECT_ID,
    });
    await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      projectId: null,
    });
    expect(mocks.artifactUpdateMany.mock.calls[1][0].data).toEqual({
      projectId: null,
    });
  });

  it("writes an owner-only patch to the artifact assignee", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      ownerUserId: OWNER_ID,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: SESSION_A,
        organizationId: ORG_ID,
        type: ArtifactType.Session,
      },
      data: { assigneeId: OWNER_ID },
    });
    expect(captureSessionGroupingChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ ownerUserId: null }),
        after: expect.objectContaining({ ownerUserId: OWNER_ID }),
      })
    );
  });

  it("404s a same-org NON-SESSION artifact on every patch shape", async () => {
    // Org scope alone would accept this id and reassign an entity Sessions
    // does not own (davetho, PR #6330); `type` in every predicate refuses it.
    const patches = [
      { ownerUserId: OWNER_ID },
      { status: SESSION_STATUS.INACTIVE },
      {},
    ] as const;

    for (const patch of patches) {
      const result = await sessionWriteService.updateSession({
        organizationId: ORG_ID,
        sessionId: NON_SESSION_ARTIFACT,
        actor: { userId: "test-actor", authMethod: "session" },
        ...patch,
      });

      expect(result).toEqual({ ok: false, error: Status.NotFound });
    }
  });

  it("404s an empty patch against a foreign id instead of 200-ing it", async () => {
    const refused = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: FOREIGN_SESSION,
      actor: { userId: "test-actor", authMethod: "session" },
    });
    expect(refused).toEqual({ ok: false, error: Status.NotFound });

    const allowed = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
    });
    expect(allowed.ok).toBe(true);
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("404s a non-uuid route id instead of letting it reach the query", async () => {
    const refused = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: "not-a-uuid",
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
    });
    expect(refused).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();

    const allowed = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
    });
    expect(allowed.ok).toBe(true);
  });

  it("refuses a cross-org project target before writing anything", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      projectId: FOREIGN_PROJECT_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });
});
