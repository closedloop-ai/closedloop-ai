/**
 * Branch-coverage top-up for `session-write-service.ts` (ISS-11280): the
 * ISS-9486 optimistic guards in `applyGuards`/`withoutUnchangedFields`, the
 * `createSession` optional-field and `startedAt` arms, the post-write
 * list-projection miss on both `createSession` and `updateSession`, the
 * empty-patch existence check, and `runSessionWrite`'s non-refusal rethrow.
 *
 * Shares the transaction double at
 * `@/__tests__/support/agent-sessions/session-write-service.test-mocks`; see
 * that file for the guard-lock (`lockedArtifactRowById`) fake this suite
 * relies on.
 */
import { AgentSessionFieldMutationErrorCode } from "@repo/api/src/types/agent-session-field-mutation";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { Status } from "@repo/api/src/types/result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_ID,
  COMPUTE_TARGET_ID,
  DELETED_SESSION,
  FOREIGN_SESSION,
  mocks,
  ORG_ID,
  OTHER_PROJECT_ID,
  OWNER_ID,
  PROJECT_ID,
  resetSessionWriteMocks,
  SESSION_A,
  tx,
} from "@/__tests__/support/agent-sessions/session-write-service.test-mocks";

vi.mock("@repo/database", () => ({
  SessionOrigin: { DESKTOP_SYNC: "DESKTOP_SYNC", LOOP: "LOOP" },
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
vi.mock("@/lib/artifact-field-edit-capture", () => ({
  captureSessionGroupingChanges,
}));

vi.mock("./session-field-edit-analytics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitSessionGroupingAnalytics,
}));

vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: { updateAssigneeAfterCommit: vi.fn() },
}));

import { sessionWriteService } from "./session-write-service";

beforeEach(() => {
  resetSessionWriteMocks();
  emitSessionGroupingAnalytics.mockReset();
});

describe("createSession — startedAt and optional fields", () => {
  it("stores the caller's startedAt instead of defaulting to now", async () => {
    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-started-at",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const data = mocks.sessionDetailCreate.mock.calls[0][0].data;
    expect(data.sessionStartedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(data.lastActivityAt).toEqual(data.sessionStartedAt);
  });

  it("carries harness and repositoryFullName through to the create when provided", async () => {
    await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-optionals",
      harness: "claude-code",
      repositoryFullName: "acme/web",
    });

    const data = mocks.sessionDetailCreate.mock.calls[0][0].data;
    expect(data.harness).toBe("claude-code");
    expect(data.repositoryFullName).toBe("acme/web");
  });

  it("returns Status.Error when the post-create list projection can't find the row", async () => {
    mocks.listSessionsByArtifactIds.mockImplementation(() =>
      Promise.resolve([])
    );

    const result = await sessionWriteService.createSession({
      organizationId: ORG_ID,
      actorUserId: ACTOR_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      externalSessionId: "ext-missing-projection",
    });

    expect(result).toEqual({ ok: false, error: Status.Error });
  });
});

describe("updateSession — post-write list projection miss", () => {
  it("404s when the post-write list projection can't find the row", async () => {
    mocks.listSessionsByArtifactIds.mockImplementation(() =>
      Promise.resolve([])
    );

    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });
});

describe("runSessionWrite — non-refusal errors are not swallowed", () => {
  it("propagates an error that is not a SessionWriteRefusal instead of returning a Result", async () => {
    mocks.artifactUpdateMany.mockImplementation(() => {
      throw new Error("connection reset");
    });

    await expect(
      sessionWriteService.updateSession({
        organizationId: ORG_ID,
        sessionId: SESSION_A,
        actor: { userId: "test-actor", authMethod: "session" },
        status: SESSION_STATUS.INACTIVE,
      })
    ).rejects.toThrow("connection reset");
  });
});

describe("updateSession — ISS-9486 optimistic guards (applyGuards)", () => {
  it("runs the guard and allows a write whose expected value still matches the locked row", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
      expectedStatus: SESSION_STATUS.ACTIVE,
    });

    expect(result).toEqual({
      ok: true,
      value: { session: expect.objectContaining({ id: SESSION_A }) },
    });
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: SESSION_STATUS.INACTIVE } })
    );
  });

  it("refuses with the stale-status conflict when the expected value no longer matches, and the requested value differs from current", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
      expectedStatus: SESSION_STATUS.ERROR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error).toMatchObject({
      status: Status.Conflict,
      code: AgentSessionFieldMutationErrorCode.StaleStatus,
      details: {
        staleStatuses: [
          {
            documentId: SESSION_A,
            currentStatus: SESSION_STATUS.ACTIVE,
            expectedStatus: SESSION_STATUS.ERROR,
          },
        ],
      },
    });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
    expect(emitSessionGroupingAnalytics).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "test-actor",
      changes: [
        {
          field: ArtifactFieldEditField.Status,
          after: SESSION_STATUS.INACTIVE,
        },
      ],
      forcedResult: ArtifactFieldEditOutcome.Conflict,
    });
  });

  it("does not refuse a retried write whose requested value already equals the current stored value, even though `expected` is stale", async () => {
    // ISS-9486 ruling 2: a first attempt already moved the stored status to
    // INACTIVE; a retry that still carries the ORIGINAL `expectedStatus`
    // (ACTIVE, now stale) but requests the SAME INACTIVE value it already
    // achieved must not 409 against its own earlier success.
    mocks.lockedArtifactRowById.set(SESSION_A, {
      status: SESSION_STATUS.INACTIVE,
      projectId: null,
    });

    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
      expectedStatus: SESSION_STATUS.ACTIVE,
    });

    expect(result.ok).toBe(true);
    // The requested status already equals the locked value, so it is dropped
    // as a no-op write (`withoutUnchangedFields`) rather than reapplied.
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
    expect(emitSessionGroupingAnalytics).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "test-actor",
      changes: [
        {
          field: ArtifactFieldEditField.Status,
          before: SESSION_STATUS.INACTIVE,
          after: SESSION_STATUS.INACTIVE,
        },
      ],
    });
  });

  it("drops every guarded field from the write once it already matches the locked row", async () => {
    mocks.lockedArtifactRowById.set(SESSION_A, {
      status: SESSION_STATUS.ACTIVE,
      projectId: null,
    });
    mocks.ownerIdBySession.set(SESSION_A, null);

    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.ACTIVE,
      projectId: null,
      ownerUserId: null,
      expectedStatus: SESSION_STATUS.ACTIVE,
      expectedProjectId: null,
      expectedOwnerUserId: null,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
    // The owner folded too: it is compared against the locked assignee.
    expect(captureSessionGroupingChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        after: {
          status: undefined,
          projectId: undefined,
          ownerUserId: undefined,
        },
      })
    );
    // Every field folded to a no-op, so the write falls to the empty-patch
    // existence check, scoped to the caller's org and to SESSION artifacts.
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith({
      where: {
        id: SESSION_A,
        organizationId: ORG_ID,
        type: ArtifactType.Session,
      },
      select: { id: true },
    });
  });

  it("404s when the guarded artifact lock finds no row for the session", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: DELETED_SESSION,
      actor: { userId: "test-actor", authMethod: "session" },
      status: SESSION_STATUS.INACTIVE,
      expectedStatus: SESSION_STATUS.ACTIVE,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });

  it("404s a guarded owner write when the artifact lock finds no row for the session", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: DELETED_SESSION,
      actor: { userId: "test-actor", authMethod: "session" },
      ownerUserId: OWNER_ID,
      expectedOwnerUserId: null,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps a requested project id that differs from the locked value when the guard is not stale", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      projectId: PROJECT_ID,
      expectedProjectId: null,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { projectId: PROJECT_ID } })
    );
  });

  it("refuses with the stale-project conflict when the expected project no longer matches, and requested differs from current", async () => {
    mocks.lockedArtifactRowById.set(SESSION_A, {
      status: SESSION_STATUS.ACTIVE,
      projectId: PROJECT_ID,
    });

    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      projectId: null,
      expectedProjectId: OTHER_PROJECT_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error).toMatchObject({
      status: Status.Conflict,
      code: AgentSessionFieldMutationErrorCode.StaleProjectId,
      details: {
        staleProjectIds: [
          {
            documentId: SESSION_A,
            currentProjectId: PROJECT_ID,
            expectedProjectId: OTHER_PROJECT_ID,
          },
        ],
      },
    });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses with the stale-owner conflict when the expected owner no longer matches, and requested differs from current", async () => {
    // The current Owner is the locked artifact's assignee (ISS-12251 D-1).
    mocks.ownerIdBySession.set(SESSION_A, ACTOR_ID);

    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      ownerUserId: null,
      expectedOwnerUserId: OWNER_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error).toMatchObject({
      status: Status.Conflict,
      code: AgentSessionFieldMutationErrorCode.StaleOwnerUserId,
      details: {
        staleOwnerUserIds: [
          {
            documentId: SESSION_A,
            currentOwnerUserId: ACTOR_ID,
            expectedOwnerUserId: OWNER_ID,
          },
        ],
      },
    });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("guards the owner alone against the locked assignee and writes it to the artifact", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: { userId: "test-actor", authMethod: "session" },
      ownerUserId: OWNER_ID,
      expectedOwnerUserId: null,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assigneeId: OWNER_ID } })
    );
  });
});

describe("updateSession — empty-patch existence check", () => {
  it("404s an empty patch on a deleted or cross-org id at the existence check", async () => {
    // Unguarded on purpose: a guarded no-op on these ids is refused by the
    // guard lock first and never reaches the existence check.
    for (const sessionId of [DELETED_SESSION, FOREIGN_SESSION]) {
      mocks.artifactFindFirst.mockClear();

      const result = await sessionWriteService.updateSession({
        organizationId: ORG_ID,
        sessionId,
        actor: { userId: "test-actor", authMethod: "session" },
      });

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      expect(mocks.artifactFindFirst).toHaveBeenCalledWith({
        where: {
          id: sessionId,
          organizationId: ORG_ID,
          type: ArtifactType.Session,
        },
        select: { id: true },
      });
    }
  });
});
