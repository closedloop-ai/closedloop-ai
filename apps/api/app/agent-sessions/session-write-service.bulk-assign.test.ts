/**
 * `bulkAssignSessions` / `commitBulkAssignment` — per-id authorization
 * (ISS-8649) and the transitions the receipt and the ledger are built from
 * (ISS-9465).
 *
 * Split out of `session-write-service.test.ts` when ISS-9465 pushed that file
 * past the 1,000-line ceiling. The transaction double both halves drive is
 * `@/__tests__/support/agent-sessions/session-write-service.test-mocks`.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_ID,
  DELETED_SESSION,
  FOREIGN_OWNER_ID,
  FOREIGN_PROJECT_ID,
  FOREIGN_SESSION,
  listRow,
  mocks,
  NON_SESSION_ARTIFACT,
  ORG_ID,
  OTHER_PROJECT_ID,
  OWNER_ID,
  PROJECT_ID,
  resetSessionWriteMocks,
  SESSION_A,
  SESSION_B,
  tx,
} from "@/__tests__/support/agent-sessions/session-write-service.test-mocks";
import { AgentSessionBulkAssignField } from "./write-contract";

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

import { sessionWriteService } from "./session-write-service";

beforeEach(resetSessionWriteMocks);

describe("bulkAssignSessions — authorization is per id (ISS-8649)", () => {
  it("assigns a project to a wholly-authorized set and reports every row", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_B],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        response: {
          field: AgentSessionBulkAssignField.Project,
          assignedCount: 2,
          sessions: [listRow(SESSION_A), listRow(SESSION_B)],
        },
        // ISS-9465: the prior value each row held, read inside the write's own
        // transaction, because `updateMany` answers with a count and the
        // receipt has to name what the artifact moved FROM.
        changes: [
          { artifactId: SESSION_A, before: null, after: PROJECT_ID },
          { artifactId: SESSION_B, before: null, after: PROJECT_ID },
        ],
      },
    });
    expect(mocks.txRolledBack).toBe(false);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [SESSION_A, SESSION_B] },
        organizationId: ORG_ID,
        type: ArtifactType.Session,
      },
      data: { projectId: PROJECT_ID },
    });
  });

  it("reports the project each row actually LEFT, not a blanket null", async () => {
    // Two rows holding DIFFERENT prior projects, because one row (or two rows
    // agreeing) cannot tell a real per-row read from a constant.
    mocks.projectIdBySession.set(SESSION_A, OTHER_PROJECT_ID);
    mocks.projectIdBySession.set(SESSION_B, null);

    const result = await sessionWriteService.commitBulkAssignment({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_B],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        changes: [
          {
            artifactId: SESSION_A,
            before: OTHER_PROJECT_ID,
            after: PROJECT_ID,
          },
          { artifactId: SESSION_B, before: null, after: PROJECT_ID },
        ],
      },
    });
  });

  it("reports the owner each row actually LEFT on the owner field", async () => {
    mocks.ownerIdBySession.set(SESSION_A, ACTOR_ID);
    mocks.ownerIdBySession.set(SESSION_B, null);

    const result = await sessionWriteService.commitBulkAssignment({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_B],
      field: AgentSessionBulkAssignField.Owner,
      value: OWNER_ID,
    });

    // Both arms lock the same artifact row; the owner arm must report its
    // ASSIGNEE, not its project, which the null projects here would hide.
    expect(result).toMatchObject({
      ok: true,
      value: {
        changes: [
          { artifactId: SESSION_A, before: ACTOR_ID, after: OWNER_ID },
          { artifactId: SESSION_B, before: null, after: OWNER_ID },
        ],
      },
    });
  });

  it("refuses a set MIXING an authorized and a cross-org id, and rolls back", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, FOREIGN_SESSION],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    // The refusal left the transaction by THROWING, which is what makes the
    // already-issued `updateMany` unwind instead of committing the authorized
    // half of the set.
    expect(mocks.txRolledBack).toBe(true);
    // And the write it did issue was org-scoped, so the foreign row was never
    // a candidate in the first place.
    expect(mocks.artifactUpdateMany.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG_ID,
    });
  });

  it("refuses a set containing a row that no longer exists", async () => {
    // The `update` vs `updateMany` trap: `update` throws P2025 on a missing
    // row, `updateMany` silently reports {count: 0}. Only comparing the count
    // against the requested id count catches this.
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, DELETED_SESSION],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.txRolledBack).toBe(true);
  });

  it("assigns an owner to the org-scoped SESSION artifacts' assignee", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_B],
      field: AgentSessionBulkAssignField.Owner,
      value: OWNER_ID,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [SESSION_A, SESSION_B] },
        organizationId: ORG_ID,
        type: ArtifactType.Session,
      },
      data: { assigneeId: OWNER_ID },
    });
  });

  it("refuses a mixed set on the OWNER field too", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, FOREIGN_SESSION],
      field: AgentSessionBulkAssignField.Owner,
      value: OWNER_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.txRolledBack).toBe(true);
  });

  it("refuses a same-org NON-SESSION artifact on either field, and rolls back", async () => {
    // A same-org artifact of another type can be named as a session id. Org
    // scope alone accepts it; only `type` in the predicate refuses it. Both
    // fields, so neither arm's write can drop `type` alone.
    for (const field of [
      AgentSessionBulkAssignField.Project,
      AgentSessionBulkAssignField.Owner,
    ]) {
      mocks.txRolledBack = false;
      const result = await sessionWriteService.bulkAssignSessions({
        organizationId: ORG_ID,
        sessionIds: [SESSION_A, NON_SESSION_ARTIFACT],
        field,
        value:
          field === AgentSessionBulkAssignField.Project ? PROJECT_ID : OWNER_ID,
      });

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      expect(mocks.txRolledBack).toBe(true);
    }
  });

  it("refuses a cross-org TARGET project and writes nothing", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A],
      field: AgentSessionBulkAssignField.Project,
      value: FOREIGN_PROJECT_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a cross-org TARGET owner and writes nothing", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A],
      field: AgentSessionBulkAssignField.Owner,
      value: FOREIGN_OWNER_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("unassigns on a null value", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A],
      field: AgentSessionBulkAssignField.Project,
      value: null,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany.mock.calls[0][0].data).toEqual({
      projectId: null,
    });
  });

  it("refuses an empty set", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("counts a duplicated id once so a repeat cannot fake a shortfall", async () => {
    const result = await sessionWriteService.bulkAssignSessions({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_A],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdateMany.mock.calls[0][0].where.id).toEqual({
      in: [SESSION_A],
    });
  });

  it("refuses when the locked read covers fewer rows than the write predicate would", async () => {
    // The lock's raw SQL and `bulkAssignWhere` are two spellings of one scope
    // and nothing makes them agree. Here the lock omits a row the write
    // predicate still matches — what a condition added to one and not the
    // other looks like. The write's ids are derived from the locked keys, so
    // the shortfall surfaces as a refusal instead of a `before: null` claiming
    // a prior project the row never had, which the ledger would keep forever.
    mocks.projectIdBySession.delete(SESSION_B);

    const result = await sessionWriteService.commitBulkAssignment({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_B],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.txRolledBack).toBe(true);
    expect(mocks.artifactUpdateMany.mock.calls[0][0].where.id).toEqual({
      in: [SESSION_A],
    });
  });

  it("refuses the same divergence on the OWNER arm", async () => {
    // Both arms share one lock, but each derives its own write set from it; a
    // project-only case cannot tell whether the owner arm does.
    mocks.projectIdBySession.delete(SESSION_B);

    const result = await sessionWriteService.commitBulkAssignment({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_B],
      field: AgentSessionBulkAssignField.Owner,
      value: OWNER_ID,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.txRolledBack).toBe(true);
    expect(mocks.artifactUpdateMany.mock.calls[0][0].where.id).toEqual({
      in: [SESSION_A],
    });
  });

  it("gives every id it wrote a prior value read under the lock, on both arms", async () => {
    mocks.projectIdBySession.set(SESSION_A, OTHER_PROJECT_ID);
    mocks.ownerIdBySession.set(SESSION_A, ACTOR_ID);

    for (const field of [
      AgentSessionBulkAssignField.Project,
      AgentSessionBulkAssignField.Owner,
    ]) {
      const isProject = field === AgentSessionBulkAssignField.Project;
      const spy = mocks.artifactUpdateMany;
      spy.mockClear();

      const result = await sessionWriteService.commitBulkAssignment({
        organizationId: ORG_ID,
        sessionIds: [SESSION_A, SESSION_B],
        field,
        value: isProject ? PROJECT_ID : OWNER_ID,
      });

      if (!result.ok) {
        throw new Error("expected the wholly-authorized set to commit");
      }
      const where = spy.mock.calls[0][0].where;
      const writtenIds = where.id.in;
      const describedIds = result.value.changes.map(
        (change) => change.artifactId
      );
      // Every id the write named is one the locked read reported, so no row
      // can reach the receipt with a fabricated prior value.
      expect(describedIds).toEqual(expect.arrayContaining(writtenIds));
      expect(result.value.changes[0].before).toBe(
        isProject ? OTHER_PROJECT_ID : ACTOR_ID
      );
    }
  });

  it("commits the assignment without the post-commit row read, so that read cannot fail an applied write", async () => {
    mocks.listSessionsByArtifactIds.mockRejectedValue(
      new Error("post-commit row read failed")
    );

    const result = await sessionWriteService.commitBulkAssignment({
      organizationId: ORG_ID,
      sessionIds: [SESSION_A, SESSION_B, SESSION_A],
      field: AgentSessionBulkAssignField.Project,
      value: PROJECT_ID,
    });

    expect(result).toMatchObject({ ok: true, value: { count: 2 } });
    expect(mocks.txRolledBack).toBe(false);
    expect(mocks.listSessionsByArtifactIds).not.toHaveBeenCalled();
  });
});
