import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
} from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkAssignSessionsInput } from "./session-write-service";
import { AgentSessionBulkAssignField } from "./write-contract";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "11111111-1111-4111-8111-111111111112";
const PROJECT_ID = "33333333-3333-4333-8333-333333333331";
const SESSION_A = "55555555-5555-4555-8555-555555555551";
const SESSION_B = "55555555-5555-4555-8555-555555555552";
/** Belongs to OTHER_ORG_ID. */
const FOREIGN_SESSION = "55555555-5555-4555-8555-555555555553";
/** Exists in no org. */
const DELETED_SESSION = "55555555-5555-4555-8555-555555555554";
/** In the caller's org, but not a SESSION artifact. */
const NON_SESSION_ARTIFACT = "55555555-5555-4555-8555-555555555555";
/**
 * A session in the caller's org with no `session_detail` row. The owner write
 * targets the artifact (ISS-12251 D-1), so it is reachable on both fields.
 */
const DETAILLESS_SESSION = "55555555-5555-4555-8555-555555555556";

type WhereShape = Record<string, unknown>;
type FakeArtifact = {
  organizationId: string;
  type: string;
};

const mocks = vi.hoisted(() => ({
  artifacts: new Map<string, { organizationId: string; type: string }>(),
  callOrder: [] as string[],
  commitBulkAssignment: vi.fn(),
  bulkAssignSessions: vi.fn(),
  artifactFindMany: vi.fn(),
  sessionDetailFindMany: vi.fn(),
}));

// Only reads exist on this fake: a write issued by the v2 service would throw.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: vi.fn((callback: (db: unknown) => unknown) =>
    callback({
      artifact: { findMany: mocks.artifactFindMany },
      sessionDetail: { findMany: mocks.sessionDetailFindMany },
    })
  ),
}));

// The real `bulkAssignWhere`, so the labelling read these cases pin is the
// write's own predicate: a change to the write's scope reaches them.
vi.mock("./session-write-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-write-service")>()),
  sessionWriteService: {
    commitBulkAssignment: mocks.commitBulkAssignment,
    bulkAssignSessions: mocks.bulkAssignSessions,
  },
}));

import { sessionBulkAssignItemService } from "./session-bulk-assign-item-service";

/**
 * Prisma semantics: an ABSENT `where` key constrains nothing, so dropping the org
 * or type predicate from production widens what these reads return.
 */
function inScope(row: FakeArtifact, scope: WhereShape): boolean {
  return (
    (scope.organizationId === undefined ||
      row.organizationId === scope.organizationId) &&
    (scope.type === undefined || row.type === scope.type)
  );
}

function idsIn(clause: unknown): string[] {
  return (clause as { in: string[] }).in;
}

function input(
  field: AgentSessionBulkAssignField,
  sessionIds: string[]
): BulkAssignSessionsInput {
  return {
    organizationId: ORG_ID,
    sessionIds,
    field,
    value: field === AgentSessionBulkAssignField.Project ? PROJECT_ID : null,
  };
}

function refused(id: string) {
  return {
    id,
    status: BatchItemFailureStatus.FailedDependency,
    code: BatchItemFailureCode.BatchRefused,
    message: expect.any(String),
  };
}

function notFound(id: string) {
  return {
    id,
    status: BatchItemFailureStatus.NotFound,
    code: BatchItemFailureCode.ArtifactsNotFound,
    message: expect.any(String),
  };
}

async function itemsById(request: BulkAssignSessionsInput) {
  const result = await sessionBulkAssignItemService.bulkAssign(request);
  if (!result.ok) {
    throw new Error(`bulkAssign returned an envelope error ${result.error}`);
  }
  return Object.fromEntries(result.value.results);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callOrder = [];
  mocks.artifacts = new Map([
    [SESSION_A, { organizationId: ORG_ID, type: ArtifactType.Session }],
    [SESSION_B, { organizationId: ORG_ID, type: ArtifactType.Session }],
    [
      FOREIGN_SESSION,
      { organizationId: OTHER_ORG_ID, type: ArtifactType.Session },
    ],
    [
      NON_SESSION_ARTIFACT,
      { organizationId: ORG_ID, type: ArtifactType.Document },
    ],
    [
      DETAILLESS_SESSION,
      { organizationId: ORG_ID, type: ArtifactType.Session },
    ],
  ]);
  mocks.commitBulkAssignment.mockImplementation(() => {
    mocks.callOrder.push("write");
    return Promise.resolve({ ok: false, error: Status.NotFound });
  });
  // v1's composite reads the assigned rows AFTER its write commits. v2 must not
  // depend on that read, so reaching it fails the case.
  mocks.bulkAssignSessions.mockRejectedValue(
    new Error("post-commit row read failed")
  );
  mocks.artifactFindMany.mockImplementation(
    ({ where }: { where: WhereShape }) => {
      mocks.callOrder.push("artifact-read");
      return Promise.resolve(
        idsIn(where.id)
          .filter((id) => {
            const row = mocks.artifacts.get(id);
            return row !== undefined && inScope(row, where);
          })
          .map((id) => ({ id }))
      );
    }
  );
  // Neither field's labelling read touches the detail row any more.
  mocks.sessionDetailFindMany.mockRejectedValue(
    new Error("bulk-assign labelling read session_detail")
  );
});

describe("sessionBulkAssignItemService.bulkAssign (ISS-9464)", () => {
  it("reports every distinct id applied from the committed write alone and never issues the labelling read", async () => {
    mocks.commitBulkAssignment.mockResolvedValue({ ok: true, value: 2 });
    const request = input(AgentSessionBulkAssignField.Project, [
      SESSION_B,
      SESSION_A,
      SESSION_B,
    ]);

    await expect(itemsById(request)).resolves.toEqual({
      [SESSION_A]: { id: SESSION_A, status: BATCH_ITEM_APPLIED_STATUS },
      [SESSION_B]: { id: SESSION_B, status: BATCH_ITEM_APPLIED_STATUS },
    });
    // ISS-10993: the second argument is the receipt writer this service passes
    // straight through, so the write owns the transaction both commit on.
    expect(mocks.commitBulkAssignment).toHaveBeenCalledWith(request, undefined);
    expect(mocks.bulkAssignSessions).not.toHaveBeenCalled();
    expect(mocks.artifactFindMany).not.toHaveBeenCalled();
    expect(mocks.sessionDetailFindMany).not.toHaveBeenCalled();
  });

  it("labels a refused PROJECT set after the write returns: unreachable ids not found, the rest refused", async () => {
    const items = await itemsById(
      input(AgentSessionBulkAssignField.Project, [
        SESSION_A,
        FOREIGN_SESSION,
        DELETED_SESSION,
        NON_SESSION_ARTIFACT,
        SESSION_B,
      ])
    );

    expect(items).toEqual({
      [SESSION_A]: refused(SESSION_A),
      [FOREIGN_SESSION]: notFound(FOREIGN_SESSION),
      [DELETED_SESSION]: notFound(DELETED_SESSION),
      [NON_SESSION_ARTIFACT]: notFound(NON_SESSION_ARTIFACT),
      [SESSION_B]: refused(SESSION_B),
    });
    expect(mocks.callOrder).toEqual(["write", "artifact-read"]);
  });

  it("labels a refused OWNER set by the artifact rows the owner write targets", async () => {
    const items = await itemsById(
      input(AgentSessionBulkAssignField.Owner, [
        SESSION_A,
        DETAILLESS_SESSION,
        FOREIGN_SESSION,
        NON_SESSION_ARTIFACT,
      ])
    );

    expect(items).toEqual({
      [SESSION_A]: refused(SESSION_A),
      // The owner is the artifact's assignee, so a detail row is not needed.
      [DETAILLESS_SESSION]: refused(DETAILLESS_SESSION),
      [FOREIGN_SESSION]: notFound(FOREIGN_SESSION),
      // Same org: only the SESSION type scope excludes it.
      [NON_SESSION_ARTIFACT]: notFound(NON_SESSION_ARTIFACT),
    });
    expect(mocks.callOrder).toEqual(["write", "artifact-read"]);
    expect(mocks.sessionDetailFindMany).not.toHaveBeenCalled();
  });

  it("passes a target refusal through as an envelope error without reading", async () => {
    mocks.commitBulkAssignment.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    await expect(
      sessionBulkAssignItemService.bulkAssign(
        input(AgentSessionBulkAssignField.Project, [SESSION_A])
      )
    ).resolves.toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.artifactFindMany).not.toHaveBeenCalled();
    expect(mocks.sessionDetailFindMany).not.toHaveBeenCalled();
  });
});
