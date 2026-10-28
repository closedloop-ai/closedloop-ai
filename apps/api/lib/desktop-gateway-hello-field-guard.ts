import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import type { Socket } from "socket.io";
import {
  isWithinMachineNameLimit,
  isWithinSupportedOperationsLimits,
} from "@/lib/compute-target-field-limits";
import type { DesktopHelloNackPayload } from "./desktop-gateway-types";
import { toEnvelope } from "./desktop-gateway-wire";

type BoundedHelloFields = {
  computeTargetId?: string;
  machineName: string;
  supportedOperations: string[];
};

/**
 * Bounds the two `desktop.hello` fields that reach a compute-target column
 * unbounded, and refuses an over-bound hello the way the rest of this handshake
 * refuses things: an error log plus a `desktop.hello.nack` carrying a reason.
 *
 * The bound deliberately does NOT live in `helloPayloadSchema`. A `safeParse`
 * failure there makes `parseHelloPayload` return `null`, whose only caller
 * answers with a bare `socket.disconnect(true)` — no log, no nack. That would
 * take an over-length `machineName` from today's "nacked with
 * `ComputeTargetUpdateFailed` and an error log naming the target" to
 * "connection drops, nothing recorded anywhere", while the desktop reconnects
 * forever regardless. Bounding here keeps the refusal and drops only the DB
 * round-trip and its error span.
 *
 * Returns `true` when the hello may proceed. When it returns `false` the socket
 * has already been nacked and disconnected.
 */
export function refuseUnboundedHelloFields(
  socket: Socket,
  payload: BoundedHelloFields
): boolean {
  // Branched for the same reason the relay hello branches: a hello carrying a
  // `computeTargetId` is the steady-state reconnect and goes to `updateOwned`,
  // so it nacks `ComputeTargetUpdateFailed`; a fresh registration goes to
  // `register` and nacks `ComputeTargetRegisterFailed`. A fixed reason would
  // change the desktop's status-bar string and its telemetry on reconnect.
  const reason = payload.computeTargetId
    ? DesktopHelloNackReason.ComputeTargetUpdateFailed
    : DesktopHelloNackReason.ComputeTargetRegisterFailed;

  if (!isWithinMachineNameLimit(payload.machineName)) {
    return nackHelloField(socket, reason, {
      computeTargetId: payload.computeTargetId,
      detail: "machineName exceeds the compute-target column bound",
      field: "machineName",
      socketId: socket.id,
    });
  }

  if (!isWithinSupportedOperationsLimits(payload.supportedOperations)) {
    return nackHelloField(socket, reason, {
      computeTargetId: payload.computeTargetId,
      detail: "supportedOperations exceeds the declared capability bound",
      field: "supportedOperations",
      socketId: socket.id,
    });
  }

  return true;
}

function nackHelloField(
  socket: Socket,
  reason: DesktopHelloNackReason,
  context: {
    computeTargetId?: string;
    detail: string;
    field: string;
    socketId: string;
  }
): false {
  log.error("desktop.gateway.hello.field_bound_exceeded", {
    computeTargetId: context.computeTargetId ?? null,
    detail: context.detail,
    field: context.field,
    reason,
    socketId: context.socketId,
  });
  socket.emit(
    "desktop.hello.nack",
    toEnvelope<DesktopHelloNackPayload>({ reason })
  );
  socket.disconnect(true);
  return false;
}
