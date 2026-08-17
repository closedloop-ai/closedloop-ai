/**
 * Kill dispatch delivery handling (`stopDesktopLoop`).
 *
 * ISS-6046. The kill rides the same relay hop as the launch, but its unsigned
 * callers -- the user-initiated cancel and the compensating cleanup after a
 * failed launch -- passed no signature, so `throwOnFailure` was false and a
 * `200 {delivered:false}` was discarded unread. `stopDesktopLoop` then fell
 * through to an info line reading exactly like a delivered kill, so a runner
 * still executing on the user's machine was recorded as stopped. It was also a
 * single attempt: ISS-5811 gave the launch three replays and left the kill at
 * one, so a loop could take any of three launch attempts and then get one
 * unchecked shot at being killed through the same degraded hop.
 *
 * Split out of `loop-desktop-dispatch.test.ts`, which covers the launch entry
 * point and the payload it builds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).logMock()
);

vi.mock("@repo/database", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).databaseMock()
);

vi.mock("@/lib/desktop-command-store", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).desktopCommandStoreMock()
);

vi.mock("@/app/compute-targets/service", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).computeTargetsServiceMock()
);

vi.mock("@/lib/compute-target-signing-eligibility", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).commandSigningEligibilityMock()
);

vi.mock("@/lib/relay-event-bus", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).relayEventBusMock()
);

vi.mock("@/app/compute-targets/relay-command-helpers", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).relayCommandHelpersMock()
);

vi.mock("@/lib/desktop-gateway-wire", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).desktopGatewayWireMock()
);

// --- Imports (after mocks) ---

import { log } from "@repo/observability/log";
import {
  stubDefaultCreateCommand,
  trackMintedCommandIds,
} from "@/__tests__/support/loops/loop-desktop-dispatch.test-helpers";
import {
  DEFAULT_COMMAND_ID,
  mockResponse,
  mockUnparseableResponse,
  RE_503,
  RE_NOT_DELIVERED,
} from "@/__tests__/support/loops/loop-desktop-dispatch.test-mocks";
import { isComputeTargetSigningEligible } from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { DispatchError, stopDesktopLoop } from "@/lib/loops/loop-desktop";
import { relayEventBus } from "@/lib/relay-event-bus";

const SIGNED_KILL_INTENT = {
  commandId: "0196b1bb-7a00-7000-8000-000000000010",
  signature: "signature",
  signaturePayload: "{}",
  publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
  body: { loopId: "loop-1", action: "loop.kill" },
};

const DISPATCHED_LOG_MESSAGE = "[loop-desktop] Desktop kill command dispatched";

describe("stopDesktopLoop delivery handling (ISS-6046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDefaultCreateCommand();
    vi.stubEnv("RELAY_API_URL", "http://relay.test");
    vi.stubEnv("INTERNAL_API_SECRET", "secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("resolves and logs the dispatch when the relay reports delivered", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    await expect(stopDesktopLoop("loop-1", "ct-1")).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      DISPATCHED_LOG_MESSAGE,
      expect.objectContaining({
        loopId: "loop-1",
        commandId: DEFAULT_COMMAND_ID,
      })
    );
  });

  it("throws when the relay reports { delivered: false } on the unsigned path", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(
      DispatchError
    );
  });

  it("does not log an undelivered kill as dispatched", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(
      DispatchError
    );
    expect(log.info).not.toHaveBeenCalledWith(
      DISPATCHED_LOG_MESSAGE,
      expect.anything()
    );
  });

  it("leaves the undelivered unsigned kill non-terminal so the reconnect replay can settle it", async () => {
    // `listNonTerminalDispatchCommands` is what re-delivers the kill when the
    // desktop reconnects. Expiring the row here would strand the orphaned
    // runner until the next desktop restart reconciles it.
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(
      DispatchError
    );
    expect(desktopCommandStore.markCommandExpired).not.toHaveBeenCalled();
  });

  // A 2xx that never says `delivered: true` -- an empty object, a null, a body
  // that is not JSON -- carries no evidence the kill reached the desktop, so it
  // has to reject like an explicit not-delivered. `stopDesktopLoopBestEffort`
  // swallows the throw and the cancel route records CANCELLED either way; what
  // rejecting buys is that the failure is logged as a failure instead of an
  // info line reading like a delivered kill, and that the unsigned command row
  // is left non-terminal for the reconnect replay to settle.
  it("throws when a relay 2xx carries no readable delivered envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(mockResponse(200, {}));

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(
      DispatchError
    );
    expect(log.info).not.toHaveBeenCalledWith(
      DISPATCHED_LOG_MESSAGE,
      expect.anything()
    );
  });

  it("throws when a relay 2xx body is not JSON at all", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(mockUnparseableResponse(200));

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(
      DispatchError
    );
    expect(log.info).not.toHaveBeenCalledWith(
      DISPATCHED_LOG_MESSAGE,
      expect.anything()
    );
  });

  it("keeps the unsigned kill available without checking signing eligibility", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    await expect(stopDesktopLoop("loop-1", "ct-1")).resolves.toBeUndefined();
    expect(isComputeTargetSigningEligible).not.toHaveBeenCalled();
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      "ct-1",
      expect.objectContaining({
        operationId: "symphony_loop_kill",
        body: { loopId: "loop-1" },
      })
    );
  });

  it("expires signed kill commands and throws when delivery fails", async () => {
    // A signed command cannot ride the reconnect replay the unsigned one does:
    // the desktop verifier refuses a signature past its max age and burns its
    // nonce, so the row is terminalized instead of left for a later delivery.
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    await expect(
      stopDesktopLoop("loop-1", "ct-1", SIGNED_KILL_INTENT)
    ).rejects.toThrow(DispatchError);
    expect(desktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      DEFAULT_COMMAND_ID,
      "signed_command_delivery_failed:target_offline",
      expect.objectContaining({
        commandId: DEFAULT_COMMAND_ID,
        operationId: "symphony_loop_kill",
        computeTargetId: "ct-1",
      })
    );
  });
});

describe("kill dispatch replay (ISS-6046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDefaultCreateCommand();
    vi.stubEnv("RELAY_API_URL", "http://relay.test");
    vi.stubEnv("INTERNAL_API_SECRET", "secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // `clearAllMocks` clears recorded calls but NOT queued `mockReturnValueOnce`
    // values. These cases queue exact response sequences, so an unconsumed entry
    // would be served to the next case.
    vi.restoreAllMocks();
  });

  it("delivers the unsigned kill when a not-delivered answer is followed by a delivery", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(mockResponse(200, { delivered: true }));

    await expect(stopDesktopLoop("loop-1", "ct-1")).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      DISPATCHED_LOG_MESSAGE,
      expect.objectContaining({ loopId: "loop-1" })
    );
  });

  it("replays the SAME commandId so a peer that already emitted cannot take two kills", async () => {
    // Replay is only safe because the id is minted once and the desktop
    // executor dedupes on it. A second mint would be a second, independently
    // executable command.
    const mintedCommandIds = trackMintedCommandIds();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(mockResponse(200, { delivered: true }));

    await stopDesktopLoop("loop-1", "ct-1");

    expect(mintedCommandIds).toEqual(["cmd-minted-1"]);
    const commandIds = fetchSpy.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)).operation.commandId
    );
    expect(commandIds).toEqual(["cmd-minted-1", "cmd-minted-1"]);
  });

  it("gives up after the same bounded number of attempts rather than replaying forever", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      );

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(
      RE_NOT_DELIVERED
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not replay a relay rejection, which is deterministic rather than transient", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(mockResponse(503, "Service Unavailable"));

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(RE_503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves no error-level log behind when the kill recovers on replay", async () => {
    // Error logs on this path feed a Datadog monitor, so a miss the next
    // attempt recovers must not fire one.
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(mockResponse(200, { delivered: true }));

    await stopDesktopLoop("loop-1", "ct-1");

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("not delivered"),
      expect.objectContaining({ reason: "target_not_connected" })
    );
  });

  it("replays the signed kill too before expiring it", async () => {
    // The signed path already checked delivery, but only once. It shares the
    // budget; the expiry is what still separates it from the unsigned path.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      );

    await expect(
      stopDesktopLoop("loop-1", "ct-1", SIGNED_KILL_INTENT)
    ).rejects.toThrow(DispatchError);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(desktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      DEFAULT_COMMAND_ID,
      "signed_command_delivery_failed:target_not_connected",
      expect.objectContaining({ computeTargetId: "ct-1" })
    );
  });
});

/**
 * The LOCAL RELAY FALLBACK transport, which is the only one a normal local run
 * exercises (`apps/api/AGENTS.md`). It reports a miss as
 * `deliveredToSubscriber: false` rather than `delivered: false`, and the
 * delivery contract has to hold identically on both.
 */
describe("kill dispatch replay over the local relay fallback (ISS-6046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDefaultCreateCommand();
    // Explicitly REMOVE the remote-transport config rather than assume it is
    // absent: `getRelayApiDispatchConfig` prefers it, so an ambient value would
    // route these cases back through fetch and prove nothing about the fallback.
    vi.stubEnv("RELAY_API_URL", undefined);
    vi.stubEnv("INTERNAL_API_SECRET", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("delivers the kill when a no-subscriber publish is followed by a delivery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("the fallback transport must not reach fetch");
    });
    vi.mocked(relayEventBus.publishOperation)
      .mockReturnValueOnce({ deliveredToSubscriber: false })
      .mockReturnValueOnce({ deliveredToSubscriber: true });

    await expect(stopDesktopLoop("loop-1", "ct-1")).resolves.toBeUndefined();
    expect(relayEventBus.publishOperation).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a no-subscriber publish as a failure and gives up on the same bound", async () => {
    vi.mocked(relayEventBus.publishOperation).mockReturnValue({
      deliveredToSubscriber: false,
    });

    await expect(stopDesktopLoop("loop-1", "ct-1")).rejects.toThrow(
      RE_NOT_DELIVERED
    );
    expect(relayEventBus.publishOperation).toHaveBeenCalledTimes(3);
  });
});
