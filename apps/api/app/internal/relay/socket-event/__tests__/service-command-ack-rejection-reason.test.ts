import { DesktopCommandAckRejectionReason } from "@repo/api/src/types/desktop-command-ack";
import { log } from "@repo/observability/log";
import { emitProtocolMetric } from "@repo/observability/telemetry/metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeDesktopCommand } from "@/lib/desktop-command-ack-handler";
import { dispatchSocketEvent } from "../service";

vi.mock("@/lib/desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitProtocolMetric: vi.fn(),
}));

const ACK_LOG_MESSAGE = "Relay command ack received";

/**
 * ISS-7486: the Datadog generator tags `relay.command_acks` off this log line's
 * fields, so the contract under test is what the line CARRIES, not that some
 * helper exists. Deleting the classify call must fail these.
 */
describe("desktop.command.ack rejection-reason tagging", () => {
  beforeEach(() => {
    vi.mocked(acknowledgeDesktopCommand).mockReset();
    vi.mocked(acknowledgeDesktopCommand).mockResolvedValue(null);
  });

  const dispatchAck = (payload: unknown) =>
    dispatchSocketEvent({
      event: "desktop.command.ack",
      payload,
      auth: null,
      targetId: "target-1",
      correlation: { gatewaySessionId: "session-1" },
      requestArrivedAt: 1000,
    });

  const ackLogPayload = (spy: {
    mock: { calls: unknown[][] };
  }): Record<string, unknown> | undefined =>
    spy.mock.calls.find((call) => call[0] === ACK_LOG_MESSAGE)?.[1] as
      | Record<string, unknown>
      | undefined;

  it("tags a rejected ack with the folded rejection code and keeps the raw reason", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({
      commandId: "cmd-1",
      accepted: false,
      reason: "cloud commands paused by user",
    });

    expect(ackLogPayload(info)).toEqual(
      expect.objectContaining({
        accepted: false,
        reason: "cloud commands paused by user",
        rejectionReason: DesktopCommandAckRejectionReason.CommandsPaused,
      })
    );
    info.mockRestore();
  });

  it("tags an unrecognized reason as unknown instead of forwarding it as a tag", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({
      commandId: "cmd-2",
      accepted: false,
      reason: "a reason from a newer desktop build",
    });

    const payload = ackLogPayload(info);
    expect(payload?.rejectionReason).toBe(
      DesktopCommandAckRejectionReason.Unknown
    );
    expect(payload?.reason).toBe("a reason from a newer desktop build");
    info.mockRestore();
  });

  it("tags a reasonless rejection as unspecified", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({ commandId: "cmd-3", accepted: false });

    expect(ackLogPayload(info)?.rejectionReason).toBe(
      DesktopCommandAckRejectionReason.Unspecified
    );
    info.mockRestore();
  });

  it("omits rejectionReason entirely on an ACCEPTED ack", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({ commandId: "cmd-4", accepted: true });

    const payload = ackLogPayload(info);
    expect(payload).toEqual(expect.objectContaining({ accepted: true }));
    // An accepted ack carrying `unspecified` would put accepted traffic in a
    // rejection bucket and re-break the very ratio this ticket is fixing.
    expect(payload).not.toHaveProperty("rejectionReason");
    info.mockRestore();
  });

  it("still forwards the raw reason to the ack handler unchanged", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({
      commandId: "cmd-5",
      accepted: false,
      reason: "unsupported method",
    });

    expect(acknowledgeDesktopCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-5",
        accepted: false,
        reason: "unsupported method",
      })
    );
    info.mockRestore();
  });

  it("does not emit ack latency when acknowledgement finds no command", async () => {
    vi.mocked(acknowledgeDesktopCommand).mockResolvedValue(null);

    await dispatchAck({ commandId: "cmd-missing", accepted: true });

    expect(emitProtocolMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({ metric: "ack_latency" })
    );
  });
});
