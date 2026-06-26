import { LoopEventType, LoopStatus } from "@repo/api/src/types/loop";
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
    emitReapReversed: vi.fn(),
  };
});

import { issueLoopRunnerToken } from "@repo/auth/loop-runner-jwt";
// Import after mocking
import { type Loop as PrismaLoop, withDb } from "@repo/database";
import {
  emitReapReversed,
  ReapReason,
} from "@/lib/observability/loop-runner-metrics";
import { buildPrismaLoop } from "../../../__tests__/fixtures/loop";
import {
  REVIVAL_GRACE_WINDOW_MS,
  REVIVAL_MAX_PER_LOOP,
} from "../loop-constants";
import { RevivalRefusedReason, reviveTimedOutLoop } from "../service";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
const mockIssueLoopRunnerToken = issueLoopRunnerToken as unknown as Mock;
const mockEmitReapReversed = emitReapReversed as unknown as Mock;

const TEST_LOOP_ID = "loop-revive-1";
const TEST_ORG_ID = "org-revive-1";
const TEST_NEW_JTI = "jti-revive-new";
const TEST_NEW_TOKEN = "eyJhbGciOiJIUzI1NiJ9.revive-token";
const TEST_EXPIRES_AT = new Date(Date.now() + 8 * 60 * 60 * 1000);

/** Within the 7-day grace window — eligible for revival. */
const RECENT_COMPLETED_AT = new Date(Date.now() - 60 * 1000); // 1 minute ago
/** Beyond the 7-day grace window — expired, not eligible. */
const EXPIRED_COMPLETED_AT = new Date(
  Date.now() - REVIVAL_GRACE_WINDOW_MS - 1000
);

/**
 * Desktop-capable loop record in TIMED_OUT status with a recent completedAt.
 * Uses buildPrismaLoop SSOT factory; overrides apply the fields reviveTimedOutLoop reads.
 */
function makeTimedOutLoopRecord(
  overrides: Partial<PrismaLoop> = {}
): PrismaLoop {
  return buildPrismaLoop({
    id: TEST_LOOP_ID,
    organizationId: TEST_ORG_ID,
    status: LoopStatus.TimedOut,
    computeTargetId: "ct-desktop-1",
    lastRunnerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1000),
    runnerCapabilities: { loopRunnerHeartbeatSupported: true },
    completedAt: RECENT_COMPLETED_AT,
    revivalCount: 0,
    ...overrides,
  });
}

/** Minimal TIMED_OUT audit event data for the heartbeat-staleness path. */
function makeHeartbeatStaleEvent(
  reason: string = ReapReason.DesktopHeartbeatStale
) {
  return {
    data: { reaper: { reason } },
  };
}

/**
 * Wire withDb and withDb.tx for reviveTimedOutLoop.
 *
 * Call order:
 *   1. withDb     → db.loop.findUnique           (pre-read, org-scoped)
 *   2. withDb     → db.loopEvent.findFirst        (TIMED_OUT audit event)
 *   3. issueLoopRunnerToken                       (token mint — separate mock)
 *   4. withDb.tx  → db.loop.updateMany (CAS)
 *                 → db.loopEvent.create           (ReapReversed audit event)
 */
function setupWithDb({
  loopRecord = makeTimedOutLoopRecord(),
  timedOutEvent = makeHeartbeatStaleEvent(),
  casCount = 1,
}: {
  loopRecord?: PrismaLoop | null;
  timedOutEvent?: { data: Record<string, unknown> } | null;
  casCount?: number;
} = {}) {
  const mockLoopFindUnique = vi.fn().mockResolvedValue(loopRecord);
  const mockLoopEventFindFirst = vi.fn().mockResolvedValue(timedOutEvent);
  const mockLoopUpdateMany = vi.fn().mockResolvedValue({ count: casCount });
  const mockLoopEventCreate = vi.fn().mockResolvedValue({});

  const buildMockDb = () => ({
    loop: {
      findUnique: mockLoopFindUnique,
      updateMany: mockLoopUpdateMany,
    },
    loopEvent: {
      findFirst: mockLoopEventFindFirst,
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
    mockLoopEventFindFirst,
    mockLoopUpdateMany,
    mockLoopEventCreate,
  };
}

describe("reviveTimedOutLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueLoopRunnerToken.mockResolvedValue({
      token: TEST_NEW_TOKEN,
      tokenId: TEST_NEW_JTI,
      expiresAt: TEST_EXPIRES_AT,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Guard rejections — table-driven
  // ---------------------------------------------------------------------------

  it.each([
    {
      name: "loop does not exist (not found)",
      loopRecord: null,
      timedOutEvent: makeHeartbeatStaleEvent(),
      expectedReason: RevivalRefusedReason.LoopNotFound,
    },
    {
      name: "loop is not in TIMED_OUT status (guard 1 — non-timed-out status)",
      loopRecord: makeTimedOutLoopRecord({ status: LoopStatus.Running }),
      timedOutEvent: makeHeartbeatStaleEvent(),
      expectedReason: RevivalRefusedReason.NotTimedOut,
    },
    {
      name: "loop has no computeTargetId (guard 2 — not desktop)",
      loopRecord: makeTimedOutLoopRecord({ computeTargetId: null }),
      timedOutEvent: makeHeartbeatStaleEvent(),
      expectedReason: RevivalRefusedReason.NotDesktop,
    },
    {
      name: "loop has computeTargetId but no heartbeat capability and no prior heartbeat (guard 2 — not desktop)",
      loopRecord: makeTimedOutLoopRecord({
        computeTargetId: "ct-1",
        runnerCapabilities: { loopRunnerHeartbeatSupported: false },
        lastRunnerHeartbeatAt: null,
      }),
      timedOutEvent: makeHeartbeatStaleEvent(),
      expectedReason: RevivalRefusedReason.NotDesktop,
    },
    {
      name: "reap reason is not heartbeat-staleness (guard 3 — non-heartbeat reap)",
      loopRecord: makeTimedOutLoopRecord(),
      timedOutEvent: makeHeartbeatStaleEvent(ReapReason.TokenExpired),
      expectedReason: RevivalRefusedReason.NonHeartbeatReap,
    },
    {
      name: "no TIMED_OUT audit event found (guard 3 — missing reap reason)",
      loopRecord: makeTimedOutLoopRecord(),
      timedOutEvent: null,
      expectedReason: RevivalRefusedReason.NonHeartbeatReap,
    },
    {
      name: "completedAt is null (guard 4 — grace window expired)",
      loopRecord: makeTimedOutLoopRecord({ completedAt: null }),
      timedOutEvent: makeHeartbeatStaleEvent(),
      expectedReason: RevivalRefusedReason.GraceWindowExpired,
    },
    {
      name: "completedAt is beyond the 7-day grace window (guard 4 — grace window expired)",
      loopRecord: makeTimedOutLoopRecord({ completedAt: EXPIRED_COMPLETED_AT }),
      timedOutEvent: makeHeartbeatStaleEvent(),
      expectedReason: RevivalRefusedReason.GraceWindowExpired,
    },
    {
      name: "revivalCount equals REVIVAL_MAX_PER_LOOP (guard 5 — cap reached)",
      loopRecord: makeTimedOutLoopRecord({
        revivalCount: REVIVAL_MAX_PER_LOOP,
      }),
      timedOutEvent: makeHeartbeatStaleEvent(),
      expectedReason: RevivalRefusedReason.RevivalCapReached,
    },
  ])("returns $expectedReason when $name", async ({
    loopRecord,
    timedOutEvent,
    expectedReason,
  }) => {
    setupWithDb({ loopRecord, timedOutEvent });

    const result = await reviveTimedOutLoop(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(expectedReason);
    }
    expect(mockIssueLoopRunnerToken).not.toHaveBeenCalled();
    expect(mockEmitReapReversed).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Desktop-heartbeat guard — DesktopNoHeartbeat reason also passes guard 3
  // ---------------------------------------------------------------------------

  it("passes guard 3 when reap reason is DesktopNoHeartbeat", async () => {
    setupWithDb({
      timedOutEvent: makeHeartbeatStaleEvent(ReapReason.DesktopNoHeartbeat),
    });

    const result = await reviveTimedOutLoop(TEST_LOOP_ID, TEST_ORG_ID);

    // Should reach token mint and CAS; with default mocks this is a happy path
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Desktop capability — prior heartbeat without capability flag also qualifies
  // ---------------------------------------------------------------------------

  it("treats a loop with a non-null lastRunnerHeartbeatAt as desktop-capable even without capability flag", async () => {
    setupWithDb({
      loopRecord: makeTimedOutLoopRecord({
        runnerCapabilities: null,
        lastRunnerHeartbeatAt: new Date(Date.now() - 10_000),
      }),
    });

    const result = await reviveTimedOutLoop(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Token mint failure
  // ---------------------------------------------------------------------------

  it("returns TOKEN_MINT_FAILED when issueLoopRunnerToken throws and does not touch the loop status", async () => {
    const { mockLoopUpdateMany } = setupWithDb();
    mockIssueLoopRunnerToken.mockRejectedValue(
      new Error("JWT signing key unavailable")
    );

    const result = await reviveTimedOutLoop(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(RevivalRefusedReason.TokenMintFailed);
    }
    expect(mockLoopUpdateMany).not.toHaveBeenCalled();
    expect(mockEmitReapReversed).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // CAS race
  // ---------------------------------------------------------------------------

  it("returns CAS_RACE when the updateMany CAS matches 0 rows (concurrent write)", async () => {
    setupWithDb({ casCount: 0 });

    const result = await reviveTimedOutLoop(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(RevivalRefusedReason.CasRace);
    }
    // Token was minted but the CAS failed, so no telemetry should be emitted
    expect(mockIssueLoopRunnerToken).toHaveBeenCalledTimes(1);
    expect(mockEmitReapReversed).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it("returns ok:true with token, expiresAt, and jti on a successful revival", async () => {
    const { mockLoopUpdateMany, mockLoopEventCreate } = setupWithDb();

    const result = await reviveTimedOutLoop(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe(TEST_NEW_TOKEN);
      expect(result.jti).toBe(TEST_NEW_JTI);
      expect(result.expiresAt).toBe(TEST_EXPIRES_AT);
    }

    // CAS predicate must include the status guard to prevent double-revival
    expect(mockLoopUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: TEST_LOOP_ID,
          organizationId: TEST_ORG_ID,
          status: LoopStatus.TimedOut,
        },
        data: expect.objectContaining({
          status: LoopStatus.Running,
          completedAt: null,
          activeTokenJti: TEST_NEW_JTI,
          tokenExpiresAt: TEST_EXPIRES_AT,
          lastRunnerHeartbeatAt: expect.any(Date),
          revivalCount: { increment: 1 },
          lastRevivalAt: expect.any(Date),
        }),
      })
    );

    // ReapReversed audit event must be written inside the same transaction
    expect(mockLoopEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loopId: TEST_LOOP_ID,
          type: LoopEventType.ReapReversed,
          eventSource: "system",
          eventId: `${LoopEventType.ReapReversed}:${TEST_NEW_JTI}`,
          data: expect.objectContaining({
            newJti: TEST_NEW_JTI,
            exp: TEST_EXPIRES_AT.toISOString(),
          }),
        }),
      })
    );

    // Telemetry emitted after the transaction
    expect(mockEmitReapReversed).toHaveBeenCalledTimes(1);
    expect(mockEmitReapReversed).toHaveBeenCalledWith(
      TEST_LOOP_ID,
      TEST_ORG_ID
    );

    // issueLoopRunnerToken called with correct claims
    expect(mockIssueLoopRunnerToken).toHaveBeenCalledWith({
      loopId: TEST_LOOP_ID,
      organizationId: TEST_ORG_ID,
    });
  });

  // ---------------------------------------------------------------------------
  // Org scoping
  // ---------------------------------------------------------------------------

  it("returns LoopNotFound when loop exists under a different org (org-scoped query returns null)", async () => {
    // findUnique returns null because the org predicate does not match
    setupWithDb({ loopRecord: null });

    const result = await reviveTimedOutLoop(TEST_LOOP_ID, "org-other-999");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(RevivalRefusedReason.LoopNotFound);
    }
  });
});
