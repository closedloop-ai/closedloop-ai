/**
 * ISS-8880 §5 — the gateway socket lane refuses an over-bound hello WITH signal.
 *
 * The bound started life as a `.refine` on `helloPayloadSchema`. That made
 * `parseHelloPayload` return `null`, whose only caller answers with a bare
 * `socket.disconnect(true)`: no log line, no `desktop.hello.nack`. Against
 * `main` the same payload parsed, reached `computeTargetsService`, raised
 * SQLSTATE 54000, and produced `desktop.gateway.hello.update_failed` plus a
 * branched nack — so bounding at the schema traded a named refusal for a
 * silent drop while the desktop reconnected forever either way.
 *
 * These cases pin the refusal's SIGNAL, not just its existence: a guard that
 * disconnects without emitting passes an "is it refused" assertion and is the
 * exact regression this file exists to catch.
 */
import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import type { Socket } from "socket.io";
import { describe, expect, it, vi } from "vitest";
import {
  MACHINE_NAME_MAX_LENGTH,
  SUPPORTED_OPERATION_MAX_LENGTH,
  SUPPORTED_OPERATIONS_MAX_COUNT,
} from "@/lib/compute-target-field-limits";
import { refuseUnboundedHelloFields } from "@/lib/desktop-gateway-hello-field-guard";

const TARGET_ID = "0199a000-0000-7000-8000-0000000000aa";

function fakeSocket() {
  return {
    disconnect: vi.fn(),
    emit: vi.fn(),
    id: "socket-1",
  } as unknown as Socket & { disconnect: ReturnType<typeof vi.fn> } & {
    emit: ReturnType<typeof vi.fn>;
  };
}

function hello(overrides: Record<string, unknown> = {}) {
  return {
    machineName: "workstation",
    supportedOperations: ["gateway.health"],
    ...overrides,
  } as Parameters<typeof refuseUnboundedHelloFields>[1];
}

/** The `["desktop.hello.nack", envelope]` pair the guard emitted, if any. */
function nackEmission(socket: ReturnType<typeof fakeSocket>) {
  const [event, envelope] = socket.emit.mock.calls[0] ?? [];
  return {
    event,
    reason: (envelope as { reason: DesktopHelloNackReason } | undefined)
      ?.reason,
  };
}

describe("refuseUnboundedHelloFields — a valid hello is untouched", () => {
  it.each([
    [
      "a name at the bound",
      { machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH) },
    ],
    ["a padded name that still fits", { machineName: "  workstation  " }],
    [
      "a declaration at the count cap",
      {
        supportedOperations: Array.from(
          { length: SUPPORTED_OPERATIONS_MAX_COUNT },
          (_, index) => `op.${index}`
        ),
      },
    ],
    [
      "an operation at the element cap",
      {
        supportedOperations: ["o".repeat(SUPPORTED_OPERATION_MAX_LENGTH)],
      },
    ],
  ])("admits %s without emitting or disconnecting", (_label, overrides) => {
    const socket = fakeSocket();

    expect(refuseUnboundedHelloFields(socket, hello(overrides))).toBe(true);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

describe("refuseUnboundedHelloFields — an over-bound hello is nacked, never dropped", () => {
  it.each([
    [
      "machineName one over",
      { machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH + 1) },
    ],
    [
      "machineName at the bound plus padding, which this lane persists raw",
      {
        machineName: `${"m".repeat(MACHINE_NAME_MAX_LENGTH)}${" ".repeat(3000)}`,
      },
    ],
    [
      "supportedOperations one past the count cap",
      {
        supportedOperations: Array.from(
          { length: SUPPORTED_OPERATIONS_MAX_COUNT + 1 },
          (_, index) => `op.${index}`
        ),
      },
    ],
    [
      "a single operation one past the element cap",
      {
        supportedOperations: ["o".repeat(SUPPORTED_OPERATION_MAX_LENGTH + 1)],
      },
    ],
  ])("%s emits a nack AND disconnects", (_label, overrides) => {
    const socket = fakeSocket();

    expect(refuseUnboundedHelloFields(socket, hello(overrides))).toBe(false);
    // Both halves matter. A refusal that only disconnects is the silent drop
    // this guard was moved out of the schema to avoid.
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});

describe("refuseUnboundedHelloFields — the nack reason branches on the arm being short-circuited", () => {
  it.each([
    ["machineName", { machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH + 1) }],
    [
      "supportedOperations",
      {
        supportedOperations: Array.from(
          { length: SUPPORTED_OPERATIONS_MAX_COUNT + 1 },
          (_, index) => `op.${index}`
        ),
      },
    ],
  ])(
    "%s on a RECONNECT nacks ComputeTargetUpdateFailed, matching updateOwned",
    (_label, overrides) => {
      // A hello carrying a `computeTargetId` is the steady state and would have
      // gone to `updateOwned`, whose catch nacks this reason. A fixed reason
      // here would change the desktop's status-bar string and its telemetry
      // mapping on every reconnect.
      const socket = fakeSocket();

      refuseUnboundedHelloFields(
        socket,
        hello({ computeTargetId: TARGET_ID, ...overrides })
      );

      expect(nackEmission(socket)).toEqual({
        event: "desktop.hello.nack",
        reason: DesktopHelloNackReason.ComputeTargetUpdateFailed,
      });
    }
  );

  it.each([
    ["machineName", { machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH + 1) }],
    [
      "supportedOperations",
      {
        supportedOperations: Array.from(
          { length: SUPPORTED_OPERATIONS_MAX_COUNT + 1 },
          (_, index) => `op.${index}`
        ),
      },
    ],
  ])(
    "%s on a FRESH registration nacks ComputeTargetRegisterFailed, matching register",
    (_label, overrides) => {
      const socket = fakeSocket();

      refuseUnboundedHelloFields(socket, hello(overrides));

      expect(nackEmission(socket)).toEqual({
        event: "desktop.hello.nack",
        reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
      });
    }
  );
});
