import { LoopStatus, RefreshTokenErrorCode } from "@repo/api/src/types/loop";
import { LoopEventType } from "@closedloop-ai/loops-api/events";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { createDatabaseMockModule } from "../../../__tests__/fixtures/mock-modules";

// Mock modules before importing the service
vi.mock("@repo/database", () => createDatabaseMockModule());

vi.mock("@repo/auth/loop-runner-jwt", () => ({
  issueLoopRunnerToken: vi.fn(),
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
  getPrismaErrorCode: vi.fn(),
}));

vi.mock("@/lib/observability/loop-runner-metrics", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/observability/loop-runner-metrics")
    >();
  return {
    ...actual,
    emitRefreshAttempt: vi.fn(),
    emitRefreshFailure: vi.fn(),
  };
});

import { issueLoopRunnerToken } from "@repo/auth/loop-runner-jwt";
// Import after mocking
import { type Loop as PrismaLoop, withDb } from "@repo/database";
import {
  emitRefreshAttempt,
  emitRefreshFailure,
  RefreshFailureReason,
} from "@/lib/observability/loop-runner-metrics";
import { buildPrismaLoop } from "../../../__tests__/fixtures/loop";
import { refreshRunnerToken } from "../service";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
const mockIssueLoopRunnerToken = issueLoopRunnerToken as unknown as Mock;
const mockEmitRefreshAttempt = emitRefreshAttempt as unknown as Mock;
const mockEmitRefreshFailure = emitRefreshFailure as unknown as Mock;

const TEST_LOOP_ID = "loop-test-refresh-1";
const TEST_ORG_ID = "org-refresh-1";
const TEST_CURRENT_JTI = "jti-current-abc";
const TEST_NEW_JTI = "jti-new-xyz";
const TEST_NEW_TOKEN = "eyJhbGciOiJIUzI1NiJ9.new-token";
const FUTURE_DATE = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours from now
const PAST_DATE = new Date(Date.now() - 60 * 1000); // 1 minute ago
const NEW_EXPIRES_AT = new Date(Date.now() + 8 * 60 * 60 * 1000);

/**
 * Loop record returned by Step 1 findUnique.
 *
 * Delegates to the shared `buildPrismaLoop` SSOT factory so refactors to the
 * `Loop` schema break tests at compile time. Pre-applies the constants this
 * file's tests need (`Running` status, active JTI, future expiry).
 */
function makeLoopRecord(overrides: Partial<PrismaLoop> = {}): PrismaLoop {
  return buildPrismaLoop({
    id: TEST_LOOP_ID,
    organizationId: TEST_ORG_ID,
    status: LoopStatus.Running,
    activeTokenJti: TEST_CURRENT_JTI,
    tokenExpiresAt: FUTURE_DATE,
    ...overrides,
  });
}

/**
 * Set up withDb and withDb.tx to return values for sequential calls in
 * refreshRunnerToken.
 *
 * Call order (after PR #1175 v2 fixups):
 *   1. withDb     → db.loop.findUnique          (Step 1: pre-read)
 *   2. withDb     → db.loopTokenRefresh.findUnique (prior-use check)
 *   3. withDb     → db.loopTokenRefresh.count      (rate-limit check)
 *   4. withDb.tx  → db.loop.updateMany            (CAS with status+jti)
 *                   → db.loopTokenRefresh.create   (audit row)
 *                   → db.loopEvent.create          (token_refreshed event)
 *   5. withDb     → db.loop.findUnique          (disambiguation re-read; only when CAS count===0)
 *   6. withDb     → db.loopTokenRefresh.findMany (cleanup; only after success)
 *   7. withDb     → db.loopTokenRefresh.deleteMany (cleanup; only if findMany returned rows)
 *
 * `loopAfterRace` controls the re-read in step 5; `refreshCountInWindow`
 * controls step 3; `auditRowsToCleanup` controls step 6.
 */
function setupWithDb({
  loopRecord = makeLoopRecord(),
  priorRefreshRow = null,
  updateManyCount = 1,
  txCreateRejects = null,
  loopAfterRace = null,
  refreshCountInWindow = 0,
  auditRowsToCleanup = [],
}: {
  loopRecord?: PrismaLoop | null;
  priorRefreshRow?: Record<string, unknown> | null;
  updateManyCount?: number;
  txCreateRejects?: Error | null;
  loopAfterRace?: PrismaLoop | null;
  refreshCountInWindow?: number;
  auditRowsToCleanup?: Array<{ id: string }>;
} = {}) {
  const mockLoopFindUnique = vi.fn();
  mockLoopFindUnique.mockResolvedValueOnce(loopRecord);
  if (loopAfterRace !== null) {
    mockLoopFindUnique.mockResolvedValueOnce(loopAfterRace);
  }
  mockLoopFindUnique.mockResolvedValue(loopRecord);

  const mockTokenRefreshFindUnique = vi.fn().mockResolvedValue(priorRefreshRow);
  const mockTokenRefreshCount = vi.fn().mockResolvedValue(refreshCountInWindow);
  const mockTokenRefreshFindMany = vi
    .fn()
    .mockResolvedValue(auditRowsToCleanup);
  const mockTokenRefreshDeleteMany = vi.fn().mockResolvedValue({
    count: auditRowsToCleanup.length,
  });
  const mockLoopUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: updateManyCount });
  const mockTokenRefreshCreate = txCreateRejects
    ? vi.fn().mockRejectedValue(txCreateRejects)
    : vi.fn().mockResolvedValue({});
  const mockLoopEventCreate = vi.fn().mockResolvedValue({});

  const buildMockDb = () => ({
    loop: {
      findUnique: mockLoopFindUnique,
      updateMany: mockLoopUpdateMany,
    },
    loopTokenRefresh: {
      findUnique: mockTokenRefreshFindUnique,
      create: mockTokenRefreshCreate,
      count: mockTokenRefreshCount,
      findMany: mockTokenRefreshFindMany,
      deleteMany: mockTokenRefreshDeleteMany,
    },
    loopEvent: {
      create: mockLoopEventCreate,
    },
  });

  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(buildMockDb())
  );
  mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(buildMockDb())
  );

  return {
    mockLoopFindUnique,
    mockTokenRefreshFindUnique,
    mockTokenRefreshCount,
    mockTokenRefreshFindMany,
    mockTokenRefreshDeleteMany,
    mockLoopUpdateMany,
    mockTokenRefreshCreate,
    mockLoopEventCreate,
  };
}

/**
 * Assert the canonical metric-emission contract for a refresh failure path:
 * one attempt metric (with the loop's orgId, or "" if the loop wasn't loaded)
 * and one failure metric (with the same orgId + mapped reason).
 */
function expectRefreshFailureMetrics(
  orgId: string,
  reason: RefreshFailureReason
) {
  // biome-ignore-start lint/suspicious/noMisplacedAssertion: shared assertion helper invoked from each failure-path test
  expect(mockEmitRefreshAttempt).toHaveBeenCalledTimes(1);
  expect(mockEmitRefreshAttempt).toHaveBeenCalledWith(orgId);
  expect(mockEmitRefreshFailure).toHaveBeenCalledTimes(1);
  expect(mockEmitRefreshFailure).toHaveBeenCalledWith(orgId, reason);
  // biome-ignore-end lint/suspicious/noMisplacedAssertion: shared assertion helper invoked from each failure-path test
}

describe("refreshRunnerToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: issueLoopRunnerToken returns a valid new token
    mockIssueLoopRunnerToken.mockResolvedValue({
      token: TEST_NEW_TOKEN,
      tokenId: TEST_NEW_JTI,
      expiresAt: NEW_EXPIRES_AT,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns LOOP_NOT_FOUND when loop does not exist and emits no org-scoped metrics", async () => {
    setupWithDb({ loopRecord: null });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.LoopNotFound);
      expect(result.message).toContain(TEST_LOOP_ID);
    }
    // No empty-orgId telemetry: the LoopNotFound path short-circuits before
    // any org-scoped emitter fires, avoiding a synthetic empty-org bucket in
    // Datadog dashboards.
    expect(mockEmitRefreshAttempt).not.toHaveBeenCalled();
    expect(mockEmitRefreshFailure).not.toHaveBeenCalled();
  });

  it("returns NOT_RUNNING when loop status is not RUNNING", async () => {
    setupWithDb({
      loopRecord: makeLoopRecord({ status: LoopStatus.Completed }),
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.NotRunning);
      expect(result.message).toContain(TEST_LOOP_ID);
    }
    expectRefreshFailureMetrics(
      TEST_ORG_ID,
      RefreshFailureReason.TerminalStatus
    );
  });

  it("returns TOKEN_EXPIRED when tokenExpiresAt is in the past", async () => {
    setupWithDb({
      loopRecord: makeLoopRecord({ tokenExpiresAt: PAST_DATE }),
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.TokenExpired);
      expect(result.message).toContain(TEST_LOOP_ID);
    }
    expectRefreshFailureMetrics(TEST_ORG_ID, RefreshFailureReason.Expired);
  });

  it("returns TOKEN_EXPIRED when tokenExpiresAt is null", async () => {
    setupWithDb({
      loopRecord: makeLoopRecord({ tokenExpiresAt: null }),
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.TokenExpired);
    }
    expectRefreshFailureMetrics(TEST_ORG_ID, RefreshFailureReason.Expired);
  });

  it("returns JTI_MISMATCH when currentJti does not match activeTokenJti", async () => {
    setupWithDb({
      loopRecord: makeLoopRecord({ activeTokenJti: "jti-different-value" }),
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.JtiMismatch);
      expect(result.message).toContain(TEST_LOOP_ID);
    }
    expectRefreshFailureMetrics(TEST_ORG_ID, RefreshFailureReason.JtiMismatch);
  });

  it("returns JTI_ALREADY_USED when a prior refresh row exists for this JTI", async () => {
    setupWithDb({
      priorRefreshRow: {
        jti: TEST_CURRENT_JTI,
        loopId: TEST_LOOP_ID,
        refreshedAt: new Date(),
      },
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.JtiAlreadyUsed);
      expect(result.message).toContain(TEST_CURRENT_JTI);
    }
    expectRefreshFailureMetrics(
      TEST_ORG_ID,
      RefreshFailureReason.StaleIdempotencyKey
    );
  });

  it("returns RATE_LIMITED when refresh count meets the per-loop window limit", async () => {
    const { mockLoopUpdateMany } = setupWithDb({
      refreshCountInWindow: 6, // matches REFRESH_RATE_LIMIT_MAX_IN_WINDOW
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.RateLimited);
      expect(result.message).toContain(TEST_LOOP_ID);
    }
    // Rate-limit short-circuits BEFORE token issuance and the CAS tx.
    expect(mockIssueLoopRunnerToken).not.toHaveBeenCalled();
    expect(mockLoopUpdateMany).not.toHaveBeenCalled();
    expectRefreshFailureMetrics(TEST_ORG_ID, RefreshFailureReason.RateLimited);
  });

  it("returns GENERATION_FAILED when issueLoopRunnerToken throws", async () => {
    setupWithDb();
    mockIssueLoopRunnerToken.mockRejectedValue(
      new Error("JWT signing key unavailable")
    );

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.GenerationFailed);
    }
    expectRefreshFailureMetrics(TEST_ORG_ID, RefreshFailureReason.Network);
  });

  it("returns RACE_LOST when the CAS update matches 0 rows and the loop is still RUNNING", async () => {
    setupWithDb({
      updateManyCount: 0,
      // Re-read sees a still-Running loop with a different active JTI:
      // someone else rotated first.
      loopAfterRace: makeLoopRecord({
        activeTokenJti: "jti-some-other-rotation",
      }),
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.RaceLost);
      expect(result.message).toContain(TEST_LOOP_ID);
    }
    expectRefreshFailureMetrics(TEST_ORG_ID, RefreshFailureReason.Network);
  });

  it("returns NOT_RUNNING when CAS matches 0 because the loop transitioned to Cancelled after the pre-read", async () => {
    setupWithDb({
      updateManyCount: 0,
      loopAfterRace: makeLoopRecord({ status: LoopStatus.Cancelled }),
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.NotRunning);
      expect(result.message).toContain(LoopStatus.Cancelled);
    }
    expectRefreshFailureMetrics(
      TEST_ORG_ID,
      RefreshFailureReason.TerminalStatus
    );
  });

  it("returns NOT_RUNNING when CAS matches 0 because the loop completed after the pre-read", async () => {
    setupWithDb({
      updateManyCount: 0,
      loopAfterRace: makeLoopRecord({ status: LoopStatus.Completed }),
    });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(RefreshTokenErrorCode.NotRunning);
      expect(result.message).toContain(LoopStatus.Completed);
    }
    expectRefreshFailureMetrics(
      TEST_ORG_ID,
      RefreshFailureReason.TerminalStatus
    );
  });

  it("propagates audit-write failure so the rotation rolls back atomically", async () => {
    const auditError = new Error("loopTokenRefresh unique constraint");
    const { mockLoopUpdateMany, mockTokenRefreshCreate } = setupWithDb({
      txCreateRejects: auditError,
    });

    await expect(
      refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI)
    ).rejects.toBe(auditError);

    // CAS attempted; audit-create attempted (and rejected). With a real
    // withDb.tx this combination rolls back, leaving activeTokenJti on the
    // original value so the runner can retry with its old token.
    expect(mockLoopUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockTokenRefreshCreate).toHaveBeenCalledTimes(1);
    // emitRefreshAttempt is called before the tx; the tx throw propagates
    // without going through any failure code path so emitRefreshFailure is not called.
    expect(mockEmitRefreshAttempt).toHaveBeenCalledTimes(1);
    expect(mockEmitRefreshAttempt).toHaveBeenCalledWith(TEST_ORG_ID);
    expect(mockEmitRefreshFailure).not.toHaveBeenCalled();
  });

  it("returns success with new token, expiresAt, and jti on the happy path", async () => {
    const { mockLoopUpdateMany, mockTokenRefreshCreate, mockLoopEventCreate } =
      setupWithDb();

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe(TEST_NEW_TOKEN);
      expect(result.jti).toBe(TEST_NEW_JTI);
      expect(result.expiresAt).toBe(NEW_EXPIRES_AT);
    }

    // Verify CAS update predicate includes id, activeTokenJti, AND status:RUNNING
    expect(mockLoopUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: TEST_LOOP_ID,
          activeTokenJti: TEST_CURRENT_JTI,
          status: LoopStatus.Running,
        },
        data: expect.objectContaining({
          activeTokenJti: TEST_NEW_JTI,
          tokenExpiresAt: NEW_EXPIRES_AT,
          // AC-005: heartbeat piggyback — token refresh also bumps lastRunnerHeartbeatAt
          lastRunnerHeartbeatAt: expect.any(Date),
        }),
      })
    );

    // Verify audit row was written
    expect(mockTokenRefreshCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loopId: TEST_LOOP_ID,
          jti: TEST_CURRENT_JTI,
        }),
      })
    );

    // Verify a token_refreshed event was emitted exactly once.
    expect(mockLoopEventCreate).toHaveBeenCalledTimes(1);

    // Verify issueLoopRunnerToken was called with correct claims
    expect(mockIssueLoopRunnerToken).toHaveBeenCalledWith({
      loopId: TEST_LOOP_ID,
      organizationId: TEST_ORG_ID,
    });

    // Metrics: attempt emitted once; no failure metric on success path
    expect(mockEmitRefreshAttempt).toHaveBeenCalledTimes(1);
    expect(mockEmitRefreshAttempt).toHaveBeenCalledWith(TEST_ORG_ID);
    expect(mockEmitRefreshFailure).not.toHaveBeenCalled();
  });

  it("emits a token_refreshed event with prevJti, newJti, exp, requesterIp, requesterUa, idempotencyKey on the rotated path", async () => {
    const { mockLoopEventCreate } = setupWithDb();

    await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI, {
      idempotencyKey: "idem-1",
      requesterIp: "10.0.0.1",
      requesterUa: "test-runner/1.0",
    });

    expect(mockLoopEventCreate).toHaveBeenCalledTimes(1);
    const call = mockLoopEventCreate.mock.calls[0][0];
    expect(call.data.type).toBe(LoopEventType.TokenRefreshed);
    expect(call.data.eventSource).toBe("system");
    expect(call.data.eventId).toBe(`token_refreshed:${TEST_CURRENT_JTI}`);
    expect(call.data.runnerTokenJti).toBe(TEST_CURRENT_JTI);
    expect(call.data.data).toEqual({
      prevJti: TEST_CURRENT_JTI,
      newJti: TEST_NEW_JTI,
      exp: NEW_EXPIRES_AT.toISOString(),
      requesterIp: "10.0.0.1",
      requesterUa: "test-runner/1.0",
      idempotencyKey: "idem-1",
    });
  });

  it("omits requester metadata keys from the event payload when not provided", async () => {
    const { mockLoopEventCreate } = setupWithDb();

    await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI, {
      idempotencyKey: "idem-2",
    });

    const payload = mockLoopEventCreate.mock.calls[0][0].data.data;
    expect(payload).toEqual({
      prevJti: TEST_CURRENT_JTI,
      newJti: TEST_NEW_JTI,
      exp: NEW_EXPIRES_AT.toISOString(),
      idempotencyKey: "idem-2",
    });
    expect(payload).not.toHaveProperty("requesterIp");
    expect(payload).not.toHaveProperty("requesterUa");
  });

  it("does not emit a token_refreshed event when the rotation is rejected as JTI_ALREADY_USED", async () => {
    const { mockLoopEventCreate } = setupWithDb({
      priorRefreshRow: {
        jti: TEST_CURRENT_JTI,
        loopId: TEST_LOOP_ID,
        refreshedAt: new Date(),
      },
    });

    await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(mockLoopEventCreate).not.toHaveBeenCalled();
  });

  it("does not emit a token_refreshed event when CAS reports a race", async () => {
    const { mockLoopEventCreate } = setupWithDb({
      updateManyCount: 0,
      loopAfterRace: makeLoopRecord({
        activeTokenJti: "jti-some-other-rotation",
      }),
    });

    await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(mockLoopEventCreate).not.toHaveBeenCalled();
  });

  it("does not emit a token_refreshed event when rate-limited", async () => {
    const { mockLoopEventCreate } = setupWithDb({
      refreshCountInWindow: 6,
    });

    await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(mockLoopEventCreate).not.toHaveBeenCalled();
  });

  it("performs bounded cleanup of audit rows after a successful rotation", async () => {
    const stale = [{ id: "id-1" }, { id: "id-2" }, { id: "id-3" }];
    const { mockTokenRefreshFindMany, mockTokenRefreshDeleteMany } =
      setupWithDb({
        auditRowsToCleanup: stale,
      });

    const result = await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(result.ok).toBe(true);
    expect(mockTokenRefreshFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { loopId: TEST_LOOP_ID },
        skip: 50, // matches REFRESH_AUDIT_RETENTION_PER_LOOP
      })
    );
    expect(mockTokenRefreshDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["id-1", "id-2", "id-3"] } },
    });
  });

  it("skips deleteMany when no audit rows exceed the retention threshold", async () => {
    const { mockTokenRefreshDeleteMany } = setupWithDb({
      auditRowsToCleanup: [],
    });

    await refreshRunnerToken(TEST_LOOP_ID, TEST_CURRENT_JTI);

    expect(mockTokenRefreshDeleteMany).not.toHaveBeenCalled();
  });
});
