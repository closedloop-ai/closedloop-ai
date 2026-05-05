/**
 * T-6.7 — Parallel POST /documents/[id]/run-loop concurrency gate
 *
 * Verifies that two simultaneous attempts to create a loop for the same
 * (documentId, non-Chat command) resolve as exactly one success and one
 * 409 LoopAlreadyActiveError.
 *
 * Tests the concurrency gate in loopsService.create directly (the same logic
 * executed by the route handler). Route-level testing requires a full Next.js
 * server harness; the service layer is where the gate is enforced and is
 * independently testable with mocked database.
 *
 * Two scenarios are covered:
 * (a) Pre-insert gate: second request's findFirst finds the first loop already
 *     active → LoopAlreadyActiveError thrown before insert.
 * (b) P2002 backstop: both requests pass the pre-insert gate (TOCTOU window),
 *     the second insert throws P2002, backstop re-read finds the first loop →
 *     LoopAlreadyActiveError thrown after insert failure.
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
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mutable handles that individual test cases can override per-call.
const mockCount = vi.fn().mockResolvedValue(0);
const mockCreate = vi.fn();
const mockFindFirst = vi.fn();
const mockOrgFindUnique = vi.fn().mockResolvedValue({ settings: null });
const mockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          count: mockCount,
          create: mockCreate,
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: mockFindFirst,
          findUnique: vi.fn().mockResolvedValue(null),
          updateMany: mockUpdateMany,
        },
        loopEvent: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        organization: {
          findUnique: mockOrgFindUnique,
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
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
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

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import {
  isLoopAlreadyActiveError,
  type LoopAlreadyActiveError,
  loopsService,
} from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOCUMENT_ID = "artifact-parallel-test";
const ORG_ID = "org-parallel-1";
const USER_ID = "user-parallel-1";

/** Minimal PLAN loop request for a specific document. */
const planLoopInput = {
  command: "PLAN" as const,
  documentId: DOCUMENT_ID,
};

/** A Prisma loop record representing an active PLAN loop on DOCUMENT_ID. */
const activeLoopRecord = {
  id: "loop-first",
  status: "RUNNING",
  command: "PLAN",
  artifactId: DOCUMENT_ID,
  organizationId: ORG_ID,
  userId: USER_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
  containerId: "container-xyz",
  workstreamId: null,
  parentLoopId: null,
  computeTargetId: null,
  prompt: null,
  repo: null,
  additionalRepos: null,
  contextRefs: null,
  artifactVersion: null,
  metadata: {},
  uploadedArtifacts: null,
  tokensByModel: null,
  tokensInput: 0,
  tokensOutput: 0,
  estimatedCost: null,
  error: null,
  s3StateKey: null,
  prUrl: null,
  prNumber: null,
  branchName: null,
  sessionId: null,
  startedAt: null,
};

/** Simulate a Prisma P2002 unique constraint violation. */
function makePrismaP2002Error(): Error & { code: string } {
  const err = new Error(
    "Unique constraint failed on the fields: (`artifact_id`,`command`)"
  );
  (err as Error & { code: string }).code = "P2002";
  return err as Error & { code: string };
}

// ---------------------------------------------------------------------------
// Scenario (a): Pre-insert gate catches the second parallel request
//
// Timeline:
//   Request-1: findFirst → null (no existing loop) → db.loop.create → loop-first
//   Request-2: findFirst → activeLoopRecord        → throws LoopAlreadyActiveError
//
// This models the common case: the second request arrives after the first loop
// is already in the DB (findFirst is the concurrency gate).
// ---------------------------------------------------------------------------

describe("parallel loopsService.create — scenario (a): pre-insert gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCount.mockResolvedValue(0);
    mockUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("resolves as one success and one LoopAlreadyActiveError", async () => {
    // Request-1 pre-insert gate: no existing loop.
    // Request-2 pre-insert gate: finds the loop inserted by Request-1.
    mockFindFirst
      .mockResolvedValueOnce(null) // Request-1 gate: clear
      .mockResolvedValueOnce(activeLoopRecord); // Request-2 gate: conflict

    // Request-1 insert succeeds.
    mockCreate.mockResolvedValueOnce({ id: "loop-first", status: "PENDING" });

    const [result1, result2] = await Promise.allSettled([
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
    ]);

    // Exactly one fulfilled (200) and one rejected (409 equivalent).
    const fulfilled = [result1, result2].filter(
      (r) => r.status === "fulfilled"
    );
    const rejected = [result1, result2].filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The successful result returns a loop ID.
    const successResult = fulfilled[0] as PromiseFulfilledResult<{
      loopId: string;
      status: string;
    }>;
    expect(successResult.value.loopId).toBe("loop-first");

    // The rejected result is a LoopAlreadyActiveError with the correct body.
    const failureResult = rejected[0] as PromiseRejectedResult;
    expect(isLoopAlreadyActiveError(failureResult.reason)).toBe(true);

    const loopError = failureResult.reason as LoopAlreadyActiveError;
    expect(loopError.existingLoopId).toBe(activeLoopRecord.id);
    expect(loopError.existingCommand).toBe(activeLoopRecord.command);
    expect(loopError.existingStatus).toBe(activeLoopRecord.status);
  });

  it("error body matches the LoopAlreadyActiveBody API contract shape", async () => {
    // Same setup: second call hits the pre-insert gate.
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeLoopRecord);
    mockCreate.mockResolvedValueOnce({ id: "loop-first", status: "PENDING" });

    const [, result2] = await Promise.allSettled([
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
    ]);

    expect(result2.status).toBe("rejected");
    const rejected = result2 as PromiseRejectedResult;
    const loopError = rejected.reason as LoopAlreadyActiveError;

    // Verify the error has all fields required by the LoopAlreadyActiveBody API contract:
    //   { error: "loop_already_active", loopId: string, command: string, status: string }
    // (The route handler maps LoopAlreadyActiveError → this JSON body.)
    expect(loopError.existingLoopId).toEqual(expect.any(String));
    expect(loopError.existingCommand).toEqual(expect.any(String));
    expect(loopError.existingStatus).toEqual(expect.any(String));
    expect(loopError.name).toBe("LoopAlreadyActiveError");
  });

  it("Chat command is exempt: both parallel Chat requests succeed for the same document", async () => {
    // The per-document concurrency gate is skipped for CHAT — findFirst is never
    // called, so both parallel requests proceed to insert independently.
    mockFindFirst.mockResolvedValue(activeLoopRecord);
    mockCreate
      .mockResolvedValueOnce({ id: "loop-chat-1", status: "PENDING" })
      .mockResolvedValueOnce({ id: "loop-chat-2", status: "PENDING" });

    const chatInput = { command: "CHAT" as const, documentId: DOCUMENT_ID };

    const [result1, result2] = await Promise.allSettled([
      loopsService.create(ORG_ID, USER_ID, chatInput),
      loopsService.create(ORG_ID, USER_ID, chatInput),
    ]);

    expect(result1.status).toBe("fulfilled");
    expect(result2.status).toBe("fulfilled");

    // findFirst must never be called — the gate is skipped for Chat.
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario (b): P2002 backstop catches the second parallel request
//
// Timeline (TOCTOU window):
//   Request-1: findFirst → null → db.loop.create → loop-first (succeeds)
//   Request-2: findFirst → null → db.loop.create → P2002 (unique constraint)
//              → backstop findFirst → activeLoopRecord → LoopAlreadyActiveError
//
// This models the race where both requests pass the pre-insert gate before
// either insert commits. The P2002 backstop converts the raw DB error into the
// structured LoopAlreadyActiveError so the caller sees the same error shape.
// ---------------------------------------------------------------------------

describe("parallel loopsService.create — scenario (b): P2002 backstop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCount.mockResolvedValue(0);
    mockUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("resolves as one success and one LoopAlreadyActiveError via P2002 backstop", async () => {
    // Both requests pass the pre-insert gate (TOCTOU: both see null).
    mockFindFirst
      .mockResolvedValueOnce(null) // Request-1 pre-insert gate: clear
      .mockResolvedValueOnce(null) // Request-2 pre-insert gate: clear (TOCTOU)
      .mockResolvedValueOnce(activeLoopRecord); // Request-2 backstop re-read: conflict

    // Request-1 insert succeeds; Request-2 insert hits P2002 unique constraint.
    mockCreate
      .mockResolvedValueOnce({ id: "loop-first", status: "PENDING" })
      .mockRejectedValueOnce(makePrismaP2002Error());

    const [result1, result2] = await Promise.allSettled([
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
    ]);

    const fulfilled = [result1, result2].filter(
      (r) => r.status === "fulfilled"
    );
    const rejected = [result1, result2].filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Successful result.
    const successResult = fulfilled[0] as PromiseFulfilledResult<{
      loopId: string;
      status: string;
    }>;
    expect(successResult.value.loopId).toBe("loop-first");

    // Failed result is a structured LoopAlreadyActiveError (not a raw P2002).
    const failureResult = rejected[0] as PromiseRejectedResult;
    expect(isLoopAlreadyActiveError(failureResult.reason)).toBe(true);

    const loopError = failureResult.reason as LoopAlreadyActiveError;
    expect(loopError.existingLoopId).toBe(activeLoopRecord.id);
    expect(loopError.existingCommand).toBe(activeLoopRecord.command);
    expect(loopError.existingStatus).toBe(activeLoopRecord.status);
  });

  it("error body matches the LoopAlreadyActiveBody API contract shape when thrown via P2002 backstop", async () => {
    mockFindFirst
      .mockResolvedValueOnce(null) // Request-1 gate
      .mockResolvedValueOnce(null) // Request-2 gate (TOCTOU)
      .mockResolvedValueOnce(activeLoopRecord); // Request-2 backstop

    mockCreate
      .mockResolvedValueOnce({ id: "loop-first", status: "PENDING" })
      .mockRejectedValueOnce(makePrismaP2002Error());

    const [, result2] = await Promise.allSettled([
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
      loopsService.create(ORG_ID, USER_ID, planLoopInput),
    ]);

    expect(result2.status).toBe("rejected");
    const rejected = result2 as PromiseRejectedResult;

    // The error must be a LoopAlreadyActiveError, not the raw P2002.
    expect(isLoopAlreadyActiveError(rejected.reason)).toBe(true);

    const loopError = rejected.reason as LoopAlreadyActiveError;
    // All fields required by LoopAlreadyActiveBody must be present on the error.
    expect(typeof loopError.existingLoopId).toBe("string");
    expect(typeof loopError.existingCommand).toBe("string");
    expect(typeof loopError.existingStatus).toBe("string");
  });
});
