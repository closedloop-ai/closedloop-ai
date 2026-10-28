import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: vi.fn() },
}));

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  branchProviderFallbackService: { findByIds: vi.fn() },
}));

vi.mock("./session-displayed-status-service", () => ({
  sessionDisplayedStatusService: { findByIds: vi.fn() },
}));

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType } from "@repo/database";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { assignedArtifactTreeService } from "./assigned-artifact-tree-service";
import { projectTreeService } from "./project-tree-service";
import { sessionDisplayedStatusService } from "./session-displayed-status-service";

/**
 * ISS-8694: BOTH artifact trees carry the server-derived session display status.
 *
 * Both, not one, is the point. Projects reads `GET /projects/:id/tree`; My Tasks
 * reads `GET /artifacts/assigned-tree` when its own flag is on and fans out over
 * the project tree when it is off. A row that badged Stale on one and Active on
 * the other is the defect, so a suite that covered a single service would leave
 * the contradiction standing on the other path.
 */

const organizationId = "33333333-3333-7333-8333-333333333333";
const projectId = "11111111-1111-7111-8111-111111111111";
const assigneeId = "22222222-2222-7222-8222-222222222222";
const sessionId = "88888888-8888-7888-8888-888888888888";
const branchId = "77777777-7777-7777-8777-777777777777";

/** The stored lifecycle value; `stale` is a read-time derivation, never this. */
const STORED_STATUS = SESSION_STATUS.ACTIVE;

let mockDb: ReturnType<typeof createMockDb>;

describe("artifact trees carry the derived session display status (ISS-8694)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    vi.mocked(branchProductEligibilityService.findByIds).mockResolvedValue(
      new Map()
    );
    vi.mocked(branchProviderFallbackService.findByIds).mockResolvedValue(
      new Set()
    );
    vi.mocked(sessionDisplayedStatusService.findByIds).mockResolvedValue(
      new Map()
    );
  });

  // ISS-10364 retired the two DISPLAY-ONLY words (`stale`/`unknown`) this
  // service existed to carry, so `sessionDisplayedStatusService.findByIds` is
  // now provably always empty in production (see its own file). The service
  // is mocked here regardless, so these two cases still pin the WIRING this
  // tree does with whatever its collaborator returns — a value that differs
  // from the row's own stored status — against a type-correct lifecycle value
  // rather than a word the real service can no longer produce. ISS-11131
  // removes this field and its service outright.
  it("serves it on the project tree without touching the stored status", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(sessionId, ArtifactType.SESSION),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    vi.mocked(sessionDisplayedStatusService.findByIds).mockResolvedValue(
      new Map([[sessionId, SESSION_STATUS.INACTIVE]])
    );

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    const root = result.nodes[0]?.root;
    expect(root?.displayedSessionStatus).toBe(SESSION_STATUS.INACTIVE);
    // The derived word is carried BESIDE the stored one, never over it.
    expect(root?.status).toBe(STORED_STATUS);
    expect(sessionDisplayedStatusService.findByIds).toHaveBeenCalledWith(
      organizationId,
      [sessionId]
    );
  });

  it("serves it on the assignee-scoped tree My Tasks reads", async () => {
    seedAssignedGraph([
      makeArtifact(sessionId, ArtifactType.SESSION, { assigneeId }),
    ]);
    vi.mocked(sessionDisplayedStatusService.findByIds).mockResolvedValue(
      new Map([[sessionId, SESSION_STATUS.ERROR]])
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      assigneeId,
      organizationId,
      assigneeId
    );

    const root = result.nodes[0]?.root;
    expect(root?.displayedSessionStatus).toBe(SESSION_STATUS.ERROR);
    expect(root?.status).toBe(STORED_STATUS);
    expect(sessionDisplayedStatusService.findByIds).toHaveBeenCalledWith(
      organizationId,
      [sessionId]
    );
  });

  it("omits the field entirely when the projection has no answer", async () => {
    // Omission, not `null`: an absent optional field is what an older client
    // already handles, and a `null` in a slot typed as an absent string is not.
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(sessionId, ArtifactType.SESSION),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    const root = result.nodes[0]?.root;
    expect(root && "displayedSessionStatus" in root).toBe(false);
    expect(root?.status).toBe(STORED_STATUS);
  });

  it("does not widen a non-session row that shares an id with the projection", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(branchId, ArtifactType.BRANCH),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    vi.mocked(sessionDisplayedStatusService.findByIds).mockResolvedValue(
      new Map([[branchId, SESSION_STATUS.INACTIVE]])
    );

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    const root = result.nodes[0]?.root;
    expect(root && "displayedSessionStatus" in root).toBe(false);
  });

  it("asks for nothing when a project holds no session rows", async () => {
    mockDb.artifact.findMany.mockResolvedValue([
      makeArtifact(branchId, ArtifactType.BRANCH),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await projectTreeService.getProjectTree(projectId, organizationId);

    expect(sessionDisplayedStatusService.findByIds).toHaveBeenCalledWith(
      organizationId,
      []
    );
  });
});

function createMockDb() {
  return {
    $queryRaw: vi.fn(),
    artifact: { findMany: vi.fn() },
    artifactLink: { findMany: vi.fn() },
  };
}

type TestArtifact = ReturnType<typeof makeArtifact>;

function makeArtifact(
  id: string,
  type: ArtifactType,
  overrides: { assigneeId?: string | null } = {}
) {
  return {
    id,
    organizationId,
    projectId,
    assigneeId: overrides.assigneeId ?? null,
    type,
    subtype: null,
    name: id,
    status: STORED_STATUS,
    sortOrder: null,
    createdAt: new Date("2026-07-03T00:00:00.000Z"),
    assignee: null,
  };
}

/**
 * Drive the assignee-scoped walk off the same org/assignee predicates the
 * production queries bind, so a query that stopped scoping returns nothing and
 * reddens the test rather than passing on an assertion-side filter.
 */
function seedAssignedGraph(artifacts: TestArtifact[]): void {
  mockDb.$queryRaw.mockImplementation((sql: unknown) => {
    const values = flattenSqlValues(sql);
    if (!(values.includes(organizationId) && values.includes(assigneeId))) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      artifacts
        .filter((row) => row.assigneeId === assigneeId)
        .map((row) => ({ id: row.id }))
    );
  });
  mockDb.artifact.findMany.mockImplementation(
    ({ where }: { where: { organizationId: string; id?: { in: string[] } } }) =>
      Promise.resolve(
        artifacts.filter(
          (row) =>
            row.organizationId === where.organizationId &&
            (where.id?.in ?? []).includes(row.id)
        )
      )
  );
  mockDb.artifactLink.findMany.mockResolvedValue([]);
}

function flattenSqlValues(node: unknown): unknown[] {
  if (!node || typeof node !== "object") {
    return [node];
  }
  if (!("values" in node)) {
    return [];
  }
  const { values } = node as { values: unknown[] };
  return values.flatMap((value) =>
    value && typeof value === "object" && "values" in value
      ? flattenSqlValues(value)
      : [value]
  );
}
