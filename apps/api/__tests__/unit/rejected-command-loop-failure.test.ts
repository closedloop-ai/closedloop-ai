import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failLoopFromRejectedCommand } from "@/lib/loops/rejected-command-loop-failure";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const COMMAND_ID = "0196b1bb-7a00-7000-8000-000000000010";
const TARGET_ID = "0196b1bb-7a00-7000-8000-000000000020";
const LOOP_ID = "0196b1bb-7a00-7000-8000-000000000030";
const ORG_ID = "0196b1bb-7a00-7000-8000-000000000040";

const mockDb = {
  desktopCommand: {
    findUnique: vi.fn(),
  },
  loop: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  loopEvent: {
    create: vi.fn(),
  },
};

function mockScopedLoopCommand(overrides?: {
  reason?: string;
  operationId?: string;
  computeTargetId?: string;
  requestPayload?: unknown;
  loopStatus?: LoopStatus;
}) {
  mockDb.desktopCommand.findUnique.mockResolvedValue({
    computeTargetId: overrides?.computeTargetId ?? TARGET_ID,
    operationId: overrides?.operationId ?? "symphony_loop",
    requestPayload: overrides?.requestPayload ?? {
      body: { loopId: LOOP_ID },
    },
  });
  mockDb.loop.findFirst.mockResolvedValue({
    organizationId: ORG_ID,
    status: overrides?.loopStatus ?? LoopStatus.Pending,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withDb).mockImplementation((callback: any) => callback(mockDb));
  mockDb.loop.updateMany.mockResolvedValue({ count: 1 });
  mockDb.loop.findUnique.mockResolvedValue({ status: LoopStatus.Pending });
  mockDb.loopEvent.create.mockResolvedValue({});
  mockScopedLoopCommand();
});

describe("failLoopFromRejectedCommand", () => {
  it.each([
    "unauthorized: no keys authorized",
    "unauthorized: unknown signing key",
  ])("fails symphony_loop for key authorization reason %s", async (reason) => {
    const result = await failLoopFromRejectedCommand({
      commandId: COMMAND_ID,
      targetId: TARGET_ID,
      reason,
    });

    expect(result).toEqual({ failed: true, loopId: LOOP_ID });
    expect(mockDb.loop.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: LOOP_ID,
          organizationId: ORG_ID,
          status: {
            in: [LoopStatus.Pending, LoopStatus.Claimed, LoopStatus.Running],
          },
        }),
        data: expect.objectContaining({
          status: LoopStatus.Failed,
          error: expect.objectContaining({
            code: LoopErrorCode.AuthChallenge,
          }),
        }),
      })
    );
    expect(mockDb.loopEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loopId: LOOP_ID,
          type: "error",
          data: expect.objectContaining({
            code: LoopErrorCode.AuthChallenge,
            result: expect.objectContaining({
              commandId: COMMAND_ID,
              computeTargetId: TARGET_ID,
              reason,
            }),
          }),
        }),
      })
    );
  });

  it.each([
    "unauthorized: unsigned command",
    "unauthorized: invalid signature",
    "unauthorized: stale or replayed command",
    "unauthorized: payload_mismatch",
    "unauthorized: something else",
    undefined,
  ])("does not fail loops for non-key reason %s", async (reason) => {
    const result = await failLoopFromRejectedCommand({
      commandId: COMMAND_ID,
      targetId: TARGET_ID,
      reason,
    });

    expect(result.failed).toBe(false);
    expect(mockDb.desktopCommand.findUnique).not.toHaveBeenCalled();
    expect(mockDb.loop.updateMany).not.toHaveBeenCalled();
    expect(mockDb.loopEvent.create).not.toHaveBeenCalled();
  });

  it("does not fail non-loop commands", async () => {
    mockScopedLoopCommand({ operationId: "symphony_loop_kill" });

    const result = await failLoopFromRejectedCommand({
      commandId: COMMAND_ID,
      targetId: TARGET_ID,
      reason: "unauthorized: unknown signing key",
    });

    expect(result).toEqual({
      failed: false,
      reason: "command_not_loop_scoped_to_target",
    });
    expect(mockDb.loop.updateMany).not.toHaveBeenCalled();
  });

  it("does not fail commands scoped to a different target", async () => {
    mockScopedLoopCommand({
      computeTargetId: "0196b1bb-7a00-7000-8000-000000000099",
    });

    const result = await failLoopFromRejectedCommand({
      commandId: COMMAND_ID,
      targetId: TARGET_ID,
      reason: "unauthorized: unknown signing key",
    });

    expect(result).toEqual({
      failed: false,
      reason: "command_not_loop_scoped_to_target",
    });
    expect(mockDb.loop.updateMany).not.toHaveBeenCalled();
  });

  it("does not fail when the stored command body lacks a string loopId", async () => {
    mockScopedLoopCommand({ requestPayload: { body: { loopId: null } } });

    const result = await failLoopFromRejectedCommand({
      commandId: COMMAND_ID,
      targetId: TARGET_ID,
      reason: "unauthorized: unknown signing key",
    });

    expect(result).toEqual({ failed: false, reason: "missing_loop_id" });
    expect(mockDb.loop.updateMany).not.toHaveBeenCalled();
  });

  it("does not fail already-terminal loops", async () => {
    mockScopedLoopCommand({ loopStatus: LoopStatus.Completed });

    const result = await failLoopFromRejectedCommand({
      commandId: COMMAND_ID,
      targetId: TARGET_ID,
      reason: "unauthorized: unknown signing key",
    });

    expect(result).toEqual({
      failed: false,
      reason: "loop_already_terminal",
    });
    expect(mockDb.loop.updateMany).not.toHaveBeenCalled();
  });
});
