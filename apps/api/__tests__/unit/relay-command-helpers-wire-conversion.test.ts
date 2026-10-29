/**
 * ISS-7558 named `relay-command-helpers.ts:108` as one of two further
 * `toWireCommandFromRelayOperation` call sites that "must be checked in the same
 * pass". It needs no code change: it converts BEFORE publishing, so a malformed
 * path short-circuits to the reason it already owns. What changed underneath it
 * is that the conversion now answers `null` instead of throwing `TypeError`, so
 * this suite pins the outcome the ticket asked to be verified.
 *
 * Because the conversion fails first, the relay transport is never reached and
 * no `RELAY_API_URL` / `INTERNAL_API_SECRET` setup is required for the
 * wire-conversion cases above. This suite also covers the relay HTTP transport
 * folds below (ISS-8133) — the branches `dispatchRelayCommandToRelay` takes
 * once a wire command DOES convert. Those folds sit behind
 * `if (env.RELAY_API_URL && env.INTERNAL_API_SECRET)`, so they need `@/env`
 * mocked with both set and `fetch` stubbed; without that mock the same inputs
 * take the in-process relay-bus branch instead and the fold assertions below
 * would pass vacuously.
 */

import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import {
  RelayDispatchDiagnosticReason,
  RelayDispatchReason,
} from "@repo/api/src/types/relay-dispatch";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchRelayCommandToRelay } from "@/app/compute-targets/relay-command-helpers";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/env", () => ({
  env: {
    RELAY_API_URL: "https://relay.test",
    INTERNAL_API_SECRET: "test-internal-secret",
  },
}));

const TARGET_ID = "target-wire-conversion";
const COMMAND_ID = "cmd-wire-conversion";
// A valid, non-reserved gateway path — required so the wire conversion
// succeeds and the transport folds below are actually reached.
const GATEWAY_PATH = "/api/gateway/symphony/launch";

function relayOperation(path: string): RelayOperationDispatchRequest {
  return {
    operationId: "op-wire-conversion",
    operation: "engineer_http_request",
    params: {
      commandId: COMMAND_ID,
      request: { method: "POST", path },
    },
    streaming: false,
  } as RelayOperationDispatchRequest;
}

describe("dispatchRelayCommandToRelay — wire conversion boundary", () => {
  it("answers wire_conversion_failed for a malformed path instead of throwing", async () => {
    // `new URL("//[", base)` used to throw TypeError straight out of this call.
    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation("//["),
    });

    expect(result).toEqual({
      delivered: false,
      reason: "wire_conversion_failed",
    });
  });

  it("answers wire_conversion_failed for a path outside the gateway namespace", async () => {
    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation("/api/documents/1"),
    });

    expect(result).toEqual({
      delivered: false,
      reason: "wire_conversion_failed",
    });
  });
});

describe("dispatchRelayCommandToRelay — relay HTTP transport folds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps a non-ok relay HTTP response to a status-templated reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 }))
    );

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(result).toEqual({ delivered: false, reason: "relay_http_502" });
  });

  it("answers relay_dispatch_failed when the relay fetch call rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable"))
    );

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(result).toEqual({
      delivered: false,
      reason: "relay_dispatch_failed",
    });
  });

  it("dispatches with a 5s AbortSignal.timeout and still answers relay_dispatch_failed once it aborts", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation was aborted.", "TimeoutError")
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dispatch"),
      expect.objectContaining({ signal: timeoutSpy.mock.results[0]?.value })
    );
    expect(result).toEqual({
      delivered: false,
      reason: "relay_dispatch_failed",
    });
  });

  it("reports delivered:true for an HTTP 200 whose body is unparseable JSON", async () => {
    // DELIBERATE PIN of current fail-open behavior, not an endorsement: the
    // `.catch(() => ({ delivered: true }))` on the response body means a
    // truncated or malformed 200 body is reported as delivered. This may be
    // intentional compatibility with an older relay that never sent a body at
    // all — it is also possible evidence for ISS-7486 (relay ack rate 0.006%
    // vs. a 98% target). Do not "fix" this by widening or dropping the pin.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not-json{", { status: 200 }))
    );

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(result).toEqual({ delivered: true, reason: undefined });
  });

  it("reports delivered:true for an HTTP 200 with an empty JSON body", async () => {
    // Same fail-open pin as above: `result.delivered !== false` treats a body
    // with no `delivered` field as delivered because nothing says otherwise.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(result).toEqual({ delivered: true, reason: undefined });
  });

  it("reports the relay's own delivered:false/reason body instead of the fail-open default — the control for the two pins above", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ delivered: false, reason: "target_offline" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
    );

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(result).toEqual({ delivered: false, reason: "target_offline" });
  });

  it("preserves relay diagnostic reasons and logs them after the coarse reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            delivered: false,
            reason: RelayDispatchReason.TargetNotConnected,
            diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
            peerStatusCode: 503,
            peerErrorCode: "ECONNRESET",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(result).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
      peerStatusCode: 503,
      peerErrorCode: "ECONNRESET",
    });
    expect(log.info).toHaveBeenCalledWith("Relay dispatch result", {
      targetId: TARGET_ID,
      computeTargetId: TARGET_ID,
      commandId: COMMAND_ID,
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
      peerStatusCode: 503,
      peerErrorCode: "ECONNRESET",
    });
    const relayDispatchLog = vi
      .mocked(log.info)
      .mock.calls.find(([message]) => message === "Relay dispatch result");
    expect(Object.keys(relayDispatchLog?.[1] ?? {})).toEqual([
      "targetId",
      "computeTargetId",
      "commandId",
      "delivered",
      "reason",
      "diagnosticReason",
      "peerStatusCode",
      "peerErrorCode",
    ]);
  });

  it("drops oversized relay diagnostic metadata before logging and returning it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            delivered: false,
            reason: RelayDispatchReason.TargetNotConnected,
            diagnosticReason: "x".repeat(200),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await dispatchRelayCommandToRelay({
      targetId: TARGET_ID,
      commandId: COMMAND_ID,
      relayOperation: relayOperation(GATEWAY_PATH),
    });

    expect(result).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
    });
    expect(log.info).toHaveBeenCalledWith("Relay dispatch result", {
      targetId: TARGET_ID,
      computeTargetId: TARGET_ID,
      commandId: COMMAND_ID,
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: undefined,
      peerStatusCode: undefined,
      peerErrorCode: undefined,
    });
  });
});
