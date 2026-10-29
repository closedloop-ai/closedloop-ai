/**
 * ISS-7223: the outcome dimension `relay.command_acks` groups by.
 *
 * The Datadog generator tags the metric off this log line's fields, so the
 * contract is what the LINE CARRIES — deleting the `ackOutcome` field must fail
 * these, not merely stop a helper being called.
 *
 * The outcome literals are written out rather than imported from
 * `desktop-command-ack`. They are tag values a dashboard and a monitor query by
 * name; an assertion that read them from the enum would agree with a rename that
 * silently broke every query.
 */

import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { DESKTOP_COMMAND_ACK_DEADLINE_MS } from "@repo/api/src/types/desktop-command-ack";
import { log } from "@repo/observability/log";
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

describe("desktop.command.ack outcome tagging", () => {
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

  it("tags an accepted ack `accepted`", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({ commandId: "cmd-1", accepted: true });

    expect(ackLogPayload(info)?.ackOutcome).toBe("accepted");
    info.mockRestore();
  });

  it("tags a rejected ack `rejected`, never the never-arrived bucket", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({
      commandId: "cmd-2",
      accepted: false,
      reason: "unsupported method",
    });

    const payload = ackLogPayload(info);
    expect(payload?.ackOutcome).toBe("rejected");
    // A rejection is a real, arrived ack. Letting it reach `timed_out` would
    // inflate the bucket that exists to count commands that never landed.
    expect(payload?.ackOutcome).not.toBe("timed_out");
    info.mockRestore();
  });

  it("keeps `accepted` on the line beside the new dimension", async () => {
    // Every existing monitor and dashboard query reads `accepted`. The new tag
    // rides beside it, not instead of it.
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await dispatchAck({ commandId: "cmd-3", accepted: true });

    expect(ackLogPayload(info)).toEqual(
      expect.objectContaining({ accepted: true, ackOutcome: "accepted" })
    );
    info.mockRestore();
  });

  /**
   * The version-skew half. Already-installed Desktop builds do not upgrade in
   * lockstep, and nothing was added to the ack WIRE payload — the outcome is
   * derived from `accepted`, the one field every build has always sent.
   *
   * Only two cases, and each drives a payload the cases above do not: the
   * REASONLESS rejection an old build sends (every rejection case above carries
   * a `reason`), and an unknown field a NEWER build might add. A third case
   * driving a bare accepted ack was removed after review — the accepted case
   * above already exercises that exact fold, so it could not have failed on its
   * own and was coverage theatre.
   */
  describe("an ack from a build that carries no new fields", () => {
    it("classifies a minimal rejected ack as rejected, not as accepted", async () => {
      // The miscount that matters: an old build's reasonless rejection must not
      // be absorbed into the accepted bucket and inflate the ack rate this
      // ticket exists to measure honestly.
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

      await dispatchAck({ commandId: "cmd-old-nack", accepted: false });

      const payload = ackLogPayload(info);
      expect(payload?.ackOutcome).toBe("rejected");
      expect(payload?.ackOutcome).not.toBe("accepted");
      expect(payload?.accepted).toBe(false);
      info.mockRestore();
    });

    it("ignores an unknown extra field a NEWER build might send", async () => {
      // Skew runs both ways: a build ahead of the cloud must not knock the ack
      // out of its bucket by carrying a field this one does not know.
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

      await dispatchAck({
        commandId: "cmd-new",
        accepted: true,
        ackOutcome: "some_future_outcome",
        somethingUnknown: { nested: true },
      });

      // Derived from `accepted` here, never adopted from the wire — otherwise a
      // client could mint unbounded tag cardinality on a Datadog dimension.
      expect(ackLogPayload(info)?.ackOutcome).toBe("accepted");
      info.mockRestore();
    });
  });

  /**
   * ISS-7223: the overlap term. The sweep retires nothing, so a command it
   * already reported `timed_out` can still be acked — and the three outcomes are
   * then observations, not a partition. This flag is what makes the intersection
   * measurable instead of leaving a reader to notice their sum exceeds
   * `relay.commands.dispatch`.
   */
  describe("an ack that arrives after the deadline", () => {
    const ackedAfter = (ms: number) => {
      vi.mocked(acknowledgeDesktopCommand).mockResolvedValue({
        commandId: "cmd-late",
        computeTargetId: "target-1",
        operationId: "op-1",
        status: DesktopCommandStatus.Accepted,
        createdAt: new Date(Date.now() - ms).toISOString(),
        lastSequenceAcked: 0,
      });
    };

    const lateLine = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.find(
        (call) => call[0] === "Relay command ack arrived late"
      )?.[1] as Record<string, unknown> | undefined;

    it("marks an ack past the deadline as late, carrying its real outcome", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      ackedAfter(DESKTOP_COMMAND_ACK_DEADLINE_MS + 1000);

      await dispatchAck({ commandId: "cmd-late", accepted: true });

      expect(lateLine(info)).toEqual(
        expect.objectContaining({
          commandId: "cmd-late",
          ackOutcome: "accepted",
          lateAck: true,
        })
      );
      info.mockRestore();
    });

    it("says nothing for an ack inside the deadline", async () => {
      // The positive sibling of the case above: if every ack were marked late,
      // the overlap term would subtract the whole accepted population.
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      ackedAfter(DESKTOP_COMMAND_ACK_DEADLINE_MS - 1000);

      await dispatchAck({ commandId: "cmd-prompt", accepted: true });

      expect(lateLine(info)).toBeUndefined();
      expect(ackLogPayload(info)?.ackOutcome).toBe("accepted");
      info.mockRestore();
    });
  });
});
