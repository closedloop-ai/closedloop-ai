/**
 * ISS-12251: an Owner write re-projects `search_document.assignee_id`, which
 * `@owner` search reads, after it commits — from the single-row PATCH write and
 * from the bulk-assign side effects — and nothing else does.
 */
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOREIGN_SESSION,
  mocks,
  ORG_ID,
  OWNER_ID,
  resetSessionWriteMocks,
  SESSION_A,
  tx,
} from "@/__tests__/support/agent-sessions/session-write-service.test-mocks";

vi.mock("@repo/database", () => ({
  SessionOrigin: { DESKTOP_SYNC: "DESKTOP_SYNC" },
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
      tx: vi.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    }
  ),
}));

vi.mock("./service/list-by-artifact-ids", () => ({
  listSessionsByArtifactIds: mocks.listSessionsByArtifactIds,
}));

const search = vi.hoisted(() => ({
  updateAssigneeAfterCommit: vi.fn(),
  updateAssigneeManyAfterCommit: vi.fn(),
}));
vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: search,
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchProjectChange: vi.fn(),
  captureBatchSessionOwnerAssignment: vi.fn(),
}));
vi.mock("@/lib/artifact-field-edit-capture", () => ({
  captureSessionGroupingChanges: vi.fn(),
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: vi.fn(),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));

import { emitBulkAssignSideEffects } from "./bulk-assign-side-effects";
import { sessionWriteService } from "./session-write-service";
import { AgentSessionBulkAssignField } from "./write-contract";

const ACTOR = { userId: "test-actor", authMethod: "session" as const };
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TXN = "11111111-1111-4111-8111-111111111111";

beforeEach(resetSessionWriteMocks);

describe("PATCH write re-projects the assignee after commit", () => {
  it("re-projects the session's row with the Owner it wrote", async () => {
    const result = await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: ACTOR,
      ownerUserId: OWNER_ID,
    });

    expect(result.ok).toBe(true);
    expect(search.updateAssigneeAfterCommit).toHaveBeenCalledExactlyOnceWith(
      {
        organizationId: ORG_ID,
        entityType: SearchEntityType.AgentSession,
        entityId: SESSION_A,
      },
      OWNER_ID
    );
  });

  it("re-projects a cleared Owner as null", async () => {
    mocks.ownerIdBySession.set(SESSION_A, OWNER_ID);

    await sessionWriteService.updateSession({
      organizationId: ORG_ID,
      sessionId: SESSION_A,
      actor: ACTOR,
      ownerUserId: null,
    });

    expect(search.updateAssigneeAfterCommit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entityId: SESSION_A }),
      null
    );
  });

  it("does not re-project for a status-only write, a same-Owner retry, or a refusal", async () => {
    mocks.ownerIdBySession.set(SESSION_A, OWNER_ID);
    const writes = [
      { sessionId: SESSION_A, status: SESSION_STATUS.INACTIVE },
      { sessionId: SESSION_A, ownerUserId: OWNER_ID },
      { sessionId: FOREIGN_SESSION, ownerUserId: OWNER_ID },
    ];

    for (const write of writes) {
      await sessionWriteService.updateSession({
        organizationId: ORG_ID,
        actor: ACTOR,
        ...write,
      });
    }

    expect(search.updateAssigneeAfterCommit).not.toHaveBeenCalled();
  });
});

describe("bulk-assign side effects re-project the assignee after commit", () => {
  it("re-projects every MOVED session of the Owner arm in one call", () => {
    emitBulkAssignSideEffects({
      user: { id: "user-1", organizationId: ORG_ID },
      authMethod: "session",
      field: AgentSessionBulkAssignField.Owner,
      changes: [
        { artifactId: ROW_A, before: "user-9", after: "user-9" },
        { artifactId: ROW_B, before: null, after: "user-9" },
      ],
      transactionId: TXN,
    });

    expect(
      search.updateAssigneeManyAfterCommit
    ).toHaveBeenCalledExactlyOnceWith(
      { organizationId: ORG_ID, entityType: SearchEntityType.AgentSession },
      [ROW_B],
      "user-9"
    );
  });

  it("does not re-project for the Project arm or a batch that moved nothing", () => {
    emitBulkAssignSideEffects({
      user: { id: "user-1", organizationId: ORG_ID },
      authMethod: "session",
      field: AgentSessionBulkAssignField.Project,
      changes: [{ artifactId: ROW_A, before: null, after: "proj-2" }],
      transactionId: TXN,
    });
    emitBulkAssignSideEffects({
      user: { id: "user-1", organizationId: ORG_ID },
      authMethod: "session",
      field: AgentSessionBulkAssignField.Owner,
      changes: [{ artifactId: ROW_A, before: "user-9", after: "user-9" }],
      transactionId: TXN,
    });

    expect(search.updateAssigneeManyAfterCommit).not.toHaveBeenCalled();
  });
});
