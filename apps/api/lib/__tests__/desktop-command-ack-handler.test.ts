import { log } from "@repo/observability/log";
import { SHORT_HASH_PATTERN } from "@repo/observability/redact-correlation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeDesktopCommand } from "@/lib/desktop-command-ack-handler";
import { desktopCommandStore } from "@/lib/desktop-command-store";

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    acknowledgeCommand: vi.fn(),
    ingestCommandEvent: vi.fn(),
  },
}));

vi.mock("@/lib/desktop-relay-event-bridge", () => ({
  publishLegacyRelayEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/loops/rejected-command-loop-failure", () => ({
  failLoopFromRejectedCommand: vi.fn().mockResolvedValue({ failed: false }),
}));

// A realistic gateway session id (the value that must never reach a log sink).
const RAW_GATEWAY_SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("acknowledgeDesktopCommand — gatewaySessionId redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktopCommandStore.acknowledgeCommand).mockResolvedValue(null);
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only a gatewaySessionIdHash (never the raw id) when a command is rejected", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    await acknowledgeDesktopCommand({
      commandId: "cmd-1",
      accepted: false,
      reason: "not supported",
      targetId: "target-1",
      context: {
        gatewaySessionId: RAW_GATEWAY_SESSION_ID,
        schemaVersion: "1",
        computeTargetId: "target-1",
        requestId: "req-1",
      },
    });

    const rejectionWarn = warnSpy.mock.calls.find(
      (args) => args[0] === "Command rejected by desktop"
    );
    expect(rejectionWarn).toBeDefined();

    const meta = rejectionWarn?.[1] as Record<string, unknown>;
    // The raw token must never appear in the log metadata, in any field.
    expect(JSON.stringify(meta)).not.toContain(RAW_GATEWAY_SESSION_ID);
    expect(meta).not.toHaveProperty("gatewaySessionId");
    // A short stable hash is logged instead so log lines stay correlatable.
    expect(meta.gatewaySessionIdHash).toMatch(SHORT_HASH_PATTERN);
  });

  it("still forwards the RAW gatewaySessionId into the store context (non-log contract)", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});

    await acknowledgeDesktopCommand({
      commandId: "cmd-1",
      accepted: false,
      reason: "rejected",
      targetId: "target-1",
      context: {
        gatewaySessionId: RAW_GATEWAY_SESSION_ID,
        schemaVersion: "1",
        computeTargetId: "target-1",
      },
    });

    // The store and the synthesized terminal error event keep the real id so DB
    // correlation / command lifecycle still works; redaction is log-only.
    expect(
      vi.mocked(desktopCommandStore.acknowledgeCommand)
    ).toHaveBeenCalledWith(
      "cmd-1",
      false,
      "rejected",
      "target-1",
      expect.objectContaining({ gatewaySessionId: RAW_GATEWAY_SESSION_ID })
    );
    const ingestInput = vi.mocked(desktopCommandStore.ingestCommandEvent).mock
      .calls[0]?.[0];
    expect(ingestInput?.context).toEqual(
      expect.objectContaining({ gatewaySessionId: RAW_GATEWAY_SESSION_ID })
    );
  });

  it("does not emit the rejection warn when the command is accepted", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    await acknowledgeDesktopCommand({
      commandId: "cmd-1",
      accepted: true,
      targetId: "target-1",
      context: {
        gatewaySessionId: RAW_GATEWAY_SESSION_ID,
        schemaVersion: "1",
        computeTargetId: "target-1",
      },
    });

    expect(
      warnSpy.mock.calls.find(
        (args) => args[0] === "Command rejected by desktop"
      )
    ).toBeUndefined();
  });
});
