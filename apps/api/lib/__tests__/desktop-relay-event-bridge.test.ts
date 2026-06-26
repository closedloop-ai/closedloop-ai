import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { publishLegacyRelayEvent } from "@/lib/desktop-relay-event-bridge";
import { failLoopFromTerminalCommandError } from "@/lib/loops/rejected-command-loop-failure";
import { relayEventBus } from "@/lib/relay-event-bus";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn() },
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: vi.fn(),
  },
}));

vi.mock("@/lib/loops/rejected-command-loop-failure", () => ({
  failLoopFromTerminalCommandError: vi
    .fn()
    .mockResolvedValue({ failed: false }),
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    publishResult: vi.fn(),
  },
}));

const COMMAND_ID = "0196b1bb-7a00-7000-8000-000000000050";
const TARGET_ID = "0196b1bb-7a00-7000-8000-000000000060";

describe("publishLegacyRelayEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue({
      commandId: COMMAND_ID,
      operationId: "symphony_loop",
      computeTargetId: TARGET_ID,
    } as Awaited<ReturnType<typeof desktopCommandStore.getCommandById>>);
  });

  it("passes non-key terminal symphony_loop rejection errors to loop failure synthesis", async () => {
    const data = {
      terminal: true,
      code: "rejected",
      error: "operation not supported",
    };

    await publishLegacyRelayEvent(COMMAND_ID, {
      commandId: COMMAND_ID,
      eventType: "error",
      data,
      sequence: 7,
    });

    expect(failLoopFromTerminalCommandError).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      targetId: TARGET_ID,
      error: "operation not supported",
    });
    expect(relayEventBus.publishResult).toHaveBeenCalledWith("symphony_loop", {
      operationId: "symphony_loop",
      event: data,
      done: true,
      error: "operation not supported",
      sequence: 7,
    });
  });
});
