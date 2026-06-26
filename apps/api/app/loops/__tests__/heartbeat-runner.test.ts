import { HeartbeatErrorCode, LoopStatus } from "@repo/api/src/types/loop";
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

import { type Loop as PrismaLoop, withDb } from "@repo/database";
import { buildPrismaLoop } from "../../../__tests__/fixtures/loop";
import { HEARTBEAT_RATE_LIMIT_WINDOW_MS } from "../loop-constants";
import { heartbeatRunner } from "../service";

const mockWithDb = withDb as unknown as Mock;

const TEST_LOOP_ID = "loop-test-heartbeat-1";
const TEST_ORG_ID = "org-heartbeat-1";

// Just past the rate-limit window: outside, eligible to bump
const OUTSIDE_RATE_LIMIT_WINDOW = new Date(
  Date.now() - HEARTBEAT_RATE_LIMIT_WINDOW_MS - 1000
);
// Halfway into the window: inside, rate-limited
const INSIDE_RATE_LIMIT_WINDOW = new Date(
  Date.now() - Math.floor(HEARTBEAT_RATE_LIMIT_WINDOW_MS / 2)
);

/**
 * Loop record returned by db.loop.findUnique.
 *
 * Delegates to the shared `buildPrismaLoop` SSOT factory. Pre-applies the
 * constants this file's tests need (Running status, null lastRunnerHeartbeatAt).
 */
function makeLoopRecord(overrides: Partial<PrismaLoop> = {}): PrismaLoop {
  return buildPrismaLoop({
    id: TEST_LOOP_ID,
    organizationId: TEST_ORG_ID,
    status: LoopStatus.Running,
    lastRunnerHeartbeatAt: null,
    ...overrides,
  });
}

/**
 * Set up withDb to return values for sequential calls in heartbeatRunner.
 *
 * Call order:
 *   1. withDb → db.loop.findUnique   (pre-read for status + lastRunnerHeartbeatAt)
 *   2. withDb → db.loop.updateMany   (bump; only when outside rate-limit window)
 *   3. withDb → db.loop.findUnique   (re-read; only when updateMany returns count=0)
 */
function setupWithDb(
  args: {
    loopRecord?: PrismaLoop | null;
    updateManyCount?: number;
    rereadLoopRecord?: PrismaLoop | null;
  } = {}
) {
  const { loopRecord = makeLoopRecord(), updateManyCount = 1 } = args;
  // Use property presence (not nullish coalescing) so callers can pass an
  // explicit `null` to model a concurrent hard-delete between the pre-read
  // and the re-read.
  const rereadValue =
    "rereadLoopRecord" in args ? args.rereadLoopRecord : loopRecord;
  const mockLoopFindUnique = vi
    .fn()
    .mockResolvedValueOnce(loopRecord)
    .mockResolvedValue(rereadValue);
  const mockLoopUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: updateManyCount });

  const buildMockDb = () => ({
    loop: {
      findUnique: mockLoopFindUnique,
      updateMany: mockLoopUpdateMany,
    },
  });

  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(buildMockDb())
  );

  return {
    mockLoopFindUnique,
    mockLoopUpdateMany,
  };
}

describe("heartbeatRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns LoopNotFound error when loop does not exist", async () => {
    setupWithDb({ loopRecord: null });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(HeartbeatErrorCode.LoopNotFound);
    }
  });

  it.each([
    LoopStatus.Completed,
    LoopStatus.Failed,
    LoopStatus.Cancelled,
    LoopStatus.TimedOut,
  ])("returns TerminalLoop error when loop status is %s", async (status) => {
    setupWithDb({ loopRecord: makeLoopRecord({ status }) });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(HeartbeatErrorCode.TerminalLoop);
    }
  });

  it("returns bumped: false when within the rate-limit window", async () => {
    const { mockLoopUpdateMany } = setupWithDb({
      loopRecord: makeLoopRecord({
        lastRunnerHeartbeatAt: INSIDE_RATE_LIMIT_WINDOW,
      }),
    });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bumped).toBe(false);
    }
    // Rate-limit short-circuits BEFORE the updateMany write
    expect(mockLoopUpdateMany).not.toHaveBeenCalled();
  });

  it("bumps lastRunnerHeartbeatAt and returns bumped: true when RUNNING and outside rate-limit window", async () => {
    const { mockLoopUpdateMany } = setupWithDb({
      loopRecord: makeLoopRecord({
        lastRunnerHeartbeatAt: OUTSIDE_RATE_LIMIT_WINDOW,
      }),
    });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bumped).toBe(true);
    }

    expect(mockLoopUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: TEST_LOOP_ID,
          organizationId: TEST_ORG_ID,
          status: LoopStatus.Running,
        },
        data: expect.objectContaining({
          lastRunnerHeartbeatAt: expect.any(Date),
        }),
      })
    );
  });

  it("bumps lastRunnerHeartbeatAt when lastRunnerHeartbeatAt is null (first heartbeat)", async () => {
    const { mockLoopUpdateMany } = setupWithDb({
      loopRecord: makeLoopRecord({ lastRunnerHeartbeatAt: null }),
    });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bumped).toBe(true);
    }
    expect(mockLoopUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("returns NotRunning when CAS misses because loop was not yet Running (Pending)", async () => {
    // Pre-read passes the terminal guard (Pending is not terminal), but
    // updateMany matches only Running → count=0. Re-read confirms Pending.
    setupWithDb({
      loopRecord: makeLoopRecord({ status: LoopStatus.Pending }),
      updateManyCount: 0,
      rereadLoopRecord: makeLoopRecord({ status: LoopStatus.Pending }),
    });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(HeartbeatErrorCode.NotRunning);
    }
  });

  it("returns LoopNotFound when CAS misses because loop was concurrently deleted", async () => {
    // Pre-read sees Running, but by the time updateMany fires the loop has
    // been hard-deleted → count=0 and re-read returns null.
    setupWithDb({
      loopRecord: makeLoopRecord({ status: LoopStatus.Running }),
      updateManyCount: 0,
      rereadLoopRecord: null,
    });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(HeartbeatErrorCode.LoopNotFound);
    }
  });

  it("returns TerminalLoop when CAS misses because loop concurrently transitioned to terminal", async () => {
    // Pre-read sees Running, but by the time updateMany fires the loop is
    // Failed → count=0. Re-read confirms terminal status.
    setupWithDb({
      loopRecord: makeLoopRecord({ status: LoopStatus.Running }),
      updateManyCount: 0,
      rereadLoopRecord: makeLoopRecord({ status: LoopStatus.Failed }),
    });

    const result = await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(HeartbeatErrorCode.TerminalLoop);
    }
  });

  it("uses org-scoped findUnique to locate the loop", async () => {
    const { mockLoopFindUnique } = setupWithDb();

    await heartbeatRunner(TEST_LOOP_ID, TEST_ORG_ID);

    expect(mockLoopFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_LOOP_ID, organizationId: TEST_ORG_ID },
      })
    );
  });
});
