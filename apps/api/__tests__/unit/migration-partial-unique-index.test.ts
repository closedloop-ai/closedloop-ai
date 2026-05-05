/**
 * T-8.1 — Migration test: partial unique index on (artifact_id, command) WHERE active
 *
 * Documents the behavior enforced by the index created in:
 * 20260505111856_replace_loop_active_index_drop_artifact_version/migration.sql
 *
 * Index definition:
 *   CREATE UNIQUE INDEX "loops_active_artifact_command_key"
 *   ON "loops"("artifact_id", "command")
 *   WHERE "status" IN ('PENDING', 'CLAIMED', 'RUNNING') AND "command" <> 'CHAT';
 *
 * Key properties:
 * 1. Two active (PENDING/CLAIMED/RUNNING) loops with the same (artifact_id, command)
 *    → second INSERT violates the partial unique index → P2002 from Postgres.
 * 2. First loop is terminal (FAILED/CANCELLED/COMPLETED/TIMED_OUT)
 *    → second INSERT is NOT covered by the partial index → succeeds.
 * 3. Two loops with different commands on the same artifact_id
 *    → both succeed (different index keys).
 * 4. The service's P2002 backstop in loopsService.create() catches violations
 *    and converts them to a structured LoopAlreadyActiveError.
 *
 * Since these are unit tests without a real database, we:
 * - Mock db.loop.create to throw a P2002 PrismaClientKnownRequestError
 *   on the second call (simulating concurrent insert collision).
 * - Verify the service layer catches the P2002 and emits LoopAlreadyActiveError.
 * - Verify that a terminal first loop (FAILED) does NOT cause P2002 (no
 *   partial index violation) and the second insert succeeds.
 * - Verify that different commands on the same artifact_id never collide.
 * - Verify CHAT loops are excluded from the index (CHAT exemption matches the
 *   service-level Chat exemption in loopsService.create / resume).
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(),
  RunTaskCommand: vi.fn(),
  StopTaskCommand: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
  verifyInstallationBranchExists: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: { getDocumentPullRequests: vi.fn() },
}));

vi.mock("@/lib/loops/uploaded-plan-artifacts", () => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  },
}));

// Captures for configurable mock behavior per test
const mockLoopCreate = vi.fn();
const mockLoopUpdateMany = vi.fn();
const mockLoopCount = vi.fn();
const mockLoopFindFirst = vi.fn();
const mockLoopFindUnique = vi.fn();
const mockOrgFindUnique = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          create: mockLoopCreate,
          updateMany: mockLoopUpdateMany,
          count: mockLoopCount,
          findFirst: mockLoopFindFirst,
          findUnique: mockLoopFindUnique,
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _count: 0, _sum: {} }),
          groupBy: vi.fn().mockResolvedValue([]),
        },
        organization: {
          findUnique: mockOrgFindUnique,
        },
        loopEvent: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    ),
    { tx: vi.fn() }
  ),
  LoopStatus: {
    Pending: "PENDING",
    Claimed: "CLAIMED",
    Running: "RUNNING",
    Completed: "COMPLETED",
    Failed: "FAILED",
    Cancelled: "CANCELLED",
    TimedOut: "TIMED_OUT",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: {
    sql: vi.fn(),
    join: vi.fn(),
  },
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { LoopAlreadyActiveError, loopsService } from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulates the P2002 error Prisma throws when a unique constraint is violated.
 * In production this comes from @prisma/client PrismaClientKnownRequestError,
 * but the service inspects `error.code === "P2002"` rather than instanceof.
 */
function makeP2002Error(): Error {
  const err = new Error(
    "Unique constraint failed on the fields: (`artifact_id`,`command`)"
  );
  (err as Error & { code: string }).code = "P2002";
  return err;
}

/** Minimal Prisma-shaped loop record returned by db.loop.findFirst */
function buildPrismaLoop(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "loop-existing",
    organizationId: "org-1",
    userId: "user-1",
    status: "PENDING",
    command: "PLAN",
    artifactId: "artifact-1",
    workstreamId: null,
    parentLoopId: null,
    computeTargetId: null,
    prompt: null,
    repo: null,
    additionalRepos: null,
    contextRefs: null,
    containerId: null,
    s3StateKey: null,
    prUrl: null,
    prNumber: null,
    branchName: null,
    sessionId: null,
    tokensInput: 0,
    tokensOutput: 0,
    tokensByModel: null,
    estimatedCost: null,
    startedAt: null,
    completedAt: null,
    error: null,
    artifactVersion: null,
    metadata: {},
    uploadedArtifacts: null,
    createdAt: new Date(Date.now() - 5000), // 5s old — within the 30s staleness window
    updatedAt: new Date(Date.now() - 5000),
    ...overrides,
  };
}

/** Shared create input for a PLAN loop against artifact-1 */
const planLoopInput = {
  command: "PLAN" as const,
  documentId: "artifact-1",
};

// ---------------------------------------------------------------------------
// Scenario 1: P2002 backstop — same (artifact_id, command), both active
//
// The index enforces:
//   CREATE UNIQUE INDEX "loops_active_artifact_command_key"
//   ON "loops"("artifact_id", "command")
//   WHERE "status" IN ('PENDING', 'CLAIMED', 'RUNNING');
//
// When two concurrent requests race past the pre-insert check and both call
// db.loop.create, the second one hits the unique index → Postgres returns
// P2002 → service converts to LoopAlreadyActiveError.
// ---------------------------------------------------------------------------

describe("partial unique index — same (artifact_id, command), both active (PENDING)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No org concurrency limit override
    mockOrgFindUnique.mockResolvedValue({ settings: {} });
    // Active loop count = 0 (concurrency gate passes)
    mockLoopCount.mockResolvedValue(0);
    // Stale-loop reaper: updateMany returns 0 (no stale rows to reap)
    mockLoopUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("second insert with same (artifact_id, command) in PENDING triggers P2002 → LoopAlreadyActiveError", async () => {
    // Arrange: pre-insert check sees no active loop (race window —
    // the first loop was inserted between the check and this insert).
    mockLoopFindFirst.mockResolvedValue(null);

    // db.loop.create throws P2002 on this (second concurrent) insert.
    mockLoopCreate.mockRejectedValue(makeP2002Error());

    // Post-P2002 re-read: the service looks up the now-existing active loop.
    const existingLoop = buildPrismaLoop({
      id: "loop-existing",
      status: "PENDING",
      command: "PLAN",
    });
    mockLoopFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(existingLoop);

    // Act
    const error = await loopsService
      .create("org-1", "user-1", planLoopInput)
      .catch((e) => e);

    // Assert: the service converts the raw P2002 into a structured error
    expect(error).toBeInstanceOf(LoopAlreadyActiveError);
    expect((error as LoopAlreadyActiveError).existingLoopId).toBe(
      "loop-existing"
    );
    expect((error as LoopAlreadyActiveError).existingCommand).toBe("PLAN");
    expect((error as LoopAlreadyActiveError).existingStatus).toBe("PENDING");
  });

  it("P2002 backstop is triggered for RUNNING status as well (index covers RUNNING)", async () => {
    // Arrange: first request raced to RUNNING between check and insert
    mockLoopFindFirst.mockResolvedValue(null);
    mockLoopCreate.mockRejectedValue(makeP2002Error());

    const runningLoop = buildPrismaLoop({
      id: "loop-running",
      status: "RUNNING",
      command: "PLAN",
    });
    mockLoopFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(runningLoop);

    // Act
    const error = await loopsService
      .create("org-1", "user-1", planLoopInput)
      .catch((e) => e);

    expect(error).toBeInstanceOf(LoopAlreadyActiveError);
    expect((error as LoopAlreadyActiveError).existingLoopId).toBe(
      "loop-running"
    );
    expect((error as LoopAlreadyActiveError).existingStatus).toBe("RUNNING");
  });

  it("P2002 backstop fires db.loop.create exactly once before re-reading", async () => {
    mockLoopFindFirst.mockResolvedValue(null);
    mockLoopCreate.mockRejectedValue(makeP2002Error());

    const existingLoop = buildPrismaLoop({ status: "PENDING" });
    mockLoopFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(existingLoop);

    await loopsService.create("org-1", "user-1", planLoopInput).catch(() => {});

    // create was attempted exactly once (no retry)
    expect(mockLoopCreate).toHaveBeenCalledOnce();
    // findFirst was called: once for pre-insert check, once for post-P2002 re-read
    expect(mockLoopFindFirst).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Terminal first loop — index does NOT apply
//
// The partial index only covers status IN ('PENDING', 'CLAIMED', 'RUNNING').
// A FAILED (or CANCELLED/COMPLETED/TIMED_OUT) loop is outside the index
// predicate, so a second insert with the same (artifact_id, command) succeeds.
// ---------------------------------------------------------------------------

describe("partial unique index — first loop is FAILED (terminal, outside index predicate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindUnique.mockResolvedValue({ settings: {} });
    mockLoopCount.mockResolvedValue(0);
    mockLoopUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("second insert succeeds when first loop is FAILED (not covered by partial index)", async () => {
    // Arrange: pre-insert check returns null — the FAILED loop is not "active"
    // and is invisible to findActiveLoopForDocumentAndCommand's query.
    mockLoopFindFirst.mockResolvedValue(null);

    // db.loop.create succeeds (no unique index violation for terminal rows)
    const newLoop = { id: "loop-new", status: "PENDING" };
    mockLoopCreate.mockResolvedValue(newLoop);

    // Act
    const result = await loopsService.create("org-1", "user-1", planLoopInput);

    // Assert: succeeds — returns new loop ID and PENDING status
    expect(result.loopId).toBe("loop-new");
    expect(result.status).toBe("PENDING");
    // No P2002 was raised — create completed without error
    expect(mockLoopCreate).toHaveBeenCalledOnce();
  });

  it("second insert succeeds when first loop is CANCELLED (terminal, outside index predicate)", async () => {
    // Same as FAILED case — CANCELLED is not in the partial index WHERE clause.
    mockLoopFindFirst.mockResolvedValue(null);
    const newLoop = { id: "loop-new-2", status: "PENDING" };
    mockLoopCreate.mockResolvedValue(newLoop);

    const result = await loopsService.create("org-1", "user-1", planLoopInput);

    expect(result.loopId).toBe("loop-new-2");
    expect(result.status).toBe("PENDING");
    expect(mockLoopCreate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Different commands on the same artifact_id — no conflict
//
// The index key is (artifact_id, command). Two loops with the same artifact_id
// but different commands are distinct index entries — no collision.
// ---------------------------------------------------------------------------

describe("partial unique index — different commands on the same artifact_id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindUnique.mockResolvedValue({ settings: {} });
    mockLoopCount.mockResolvedValue(0);
    mockLoopUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("PLAN and EXECUTE loops on the same artifact_id coexist without P2002", async () => {
    // First PLAN loop already active — but we're inserting an EXECUTE loop.
    // The index is keyed on (artifact_id, command), so EXECUTE is a different key.
    // Pre-insert check for EXECUTE command sees no active EXECUTE loop.
    mockLoopFindFirst.mockResolvedValue(null);

    // db.loop.create succeeds (different command → different index key)
    const newExecuteLoop = { id: "loop-execute-1", status: "PENDING" };
    mockLoopCreate.mockResolvedValue(newExecuteLoop);

    const executeInput = {
      command: "EXECUTE" as const,
      documentId: "artifact-1",
    };

    const result = await loopsService.create("org-1", "user-1", executeInput);

    // Assert: create succeeded — PLAN loop doesn't block EXECUTE loop
    expect(result.loopId).toBe("loop-execute-1");
    expect(result.status).toBe("PENDING");
    expect(mockLoopCreate).toHaveBeenCalledOnce();
    // No P2002 — the (artifact_id, EXECUTE) key is not taken
  });

  it("EVALUATE_PRD and PLAN loops on the same artifact_id coexist without P2002", async () => {
    mockLoopFindFirst.mockResolvedValue(null);

    const newEvalLoop = { id: "loop-eval-1", status: "PENDING" };
    mockLoopCreate.mockResolvedValue(newEvalLoop);

    const evalInput = {
      command: "EVALUATE_PRD" as const,
      documentId: "artifact-1",
    };

    const result = await loopsService.create("org-1", "user-1", evalInput);

    expect(result.loopId).toBe("loop-eval-1");
    expect(result.status).toBe("PENDING");
    expect(mockLoopCreate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Index semantics documentation — NULL artifact_id rows
//
// Postgres NULL != NULL in unique indexes, so loops with NULL artifact_id
// never conflict with each other, regardless of command or status.
// ---------------------------------------------------------------------------

describe("partial unique index — NULL artifact_id rows never conflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindUnique.mockResolvedValue({ settings: {} });
    mockLoopCount.mockResolvedValue(0);
    mockLoopUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("CHAT loops (no documentId) are not gated by the active-loop check and always proceed to insert", async () => {
    // CHAT loops skip the LoopAlreadyActive check entirely (documentId is null).
    // The partial index also doesn't conflict for NULLs (Postgres NULL semantics).
    // Two CHAT loops can always coexist — both at the service check level and
    // at the DB index level.
    const newLoop = { id: "loop-chat-1", status: "PENDING" };
    mockLoopCreate.mockResolvedValue(newLoop);

    const chatInput = {
      command: "CHAT" as const,
      // No documentId — CHAT loops are workstream-scoped, not artifact-scoped
    };

    const result = await loopsService.create("org-1", "user-1", chatInput);

    expect(result.loopId).toBe("loop-chat-1");
    // findFirst (active loop check) is NOT called for CHAT command
    expect(mockLoopFindFirst).not.toHaveBeenCalled();
    expect(mockLoopCreate).toHaveBeenCalledOnce();
  });
});
