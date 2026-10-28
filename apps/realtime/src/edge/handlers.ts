import { log } from "@repo/observability/log";
import {
  RealtimeErrorCode,
  type RealtimeErrorCode as RealtimeErrorCodeValue,
} from "@repo/realtime-contract/error-codes";
import {
  type JoinAck,
  joinPayloadSchema,
  leavePayloadSchema,
  RealtimeEvent,
  type RefreshAck,
  refreshPayloadSchema,
} from "@repo/realtime-contract/protocol";
import type { Revocations } from "@repo/realtime-contract/revocations";
import {
  type RealtimeTokenClaims,
  RealtimeTokenError,
  type RealtimeTokenVerifyOptions,
  verifyRealtimeToken,
} from "@repo/realtime-contract/token";
import { startJoinSpan } from "../telemetry/spans";
import {
  admitJoin,
  type JoinOutcome,
  leaveChannel,
  leaveUngrantedChannels,
} from "./channels";
import { describeFault } from "./fault";
import type { RealtimeSocket } from "./socket-server";
import {
  armTokenExpiry,
  type Clock,
  type ConnectionState,
  tokenExpiresAtMs,
} from "./token-expiry";

type FailureAck = { ok: false; code: RealtimeErrorCodeValue };

/** The contract declares no leave ack; a leave only ever succeeds or is malformed. */
export type LeaveAck = { ok: true } | FailureAck;

export type HandlerOptions = {
  tokenKeys: RealtimeTokenVerifyOptions;
  now: Clock;
  revocations: Revocations;
};

/**
 * `rt:join`, `rt:leave` and `rt:refresh`. Each validates its payload against
 * the contract schema and always acknowledges; a malformed payload is acked
 * `internal`, and a client that sent no ack callback is tolerated. Any other
 * event has no listener and is ignored, socket.io's default.
 */
export function registerHandlers(
  socket: RealtimeSocket,
  state: ConnectionState,
  options: HandlerOptions
): void {
  onAckedEvent(socket, RealtimeEvent.Join, (payload) =>
    handleJoin(socket, payload, options.revocations)
  );
  onAckedEvent(socket, RealtimeEvent.Leave, (payload) =>
    handleLeave(socket, payload)
  );
  // Verification is asynchronous, so a later refresh can finish first.
  // Applying refreshes in arrival order keeps the newest token's claims and
  // expiry in force.
  let refreshes: Promise<unknown> = Promise.resolve();
  onAckedEvent(socket, RealtimeEvent.Refresh, (payload) => {
    const refreshed = refreshes.then(() =>
      handleRefresh(socket, state, options, payload)
    );
    refreshes = refreshed.catch(() => undefined);
    return refreshed;
  });
}

function handleJoin(
  socket: RealtimeSocket,
  payload: unknown,
  revocations: Revocations
): JoinAck {
  const parsed = joinPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return MALFORMED_PAYLOAD_ACK;
  }
  const endSpan = startJoinSpan(socket);
  let outcome: JoinOutcome = { ack: MALFORMED_PAYLOAD_ACK, kind: undefined };
  try {
    outcome = admitJoin(socket, parsed.data.channel, revocations);
    return outcome.ack;
  } finally {
    endSpan(outcome);
  }
}

function handleLeave(socket: RealtimeSocket, payload: unknown): LeaveAck {
  const parsed = leavePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return MALFORMED_PAYLOAD_ACK;
  }
  leaveChannel(socket, parsed.data.channel);
  return { ok: true };
}
/**
 * Swaps the socket's claims for a freshly verified token, then leaves every
 * joined channel the new grants no longer cover. A token for a different
 * organization or user is refused `forbidden`: a refresh renews a session, it
 * never changes whose session it is.
 */
async function handleRefresh(
  socket: RealtimeSocket,
  state: ConnectionState,
  options: HandlerOptions,
  payload: unknown
): Promise<RefreshAck> {
  const parsed = refreshPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return MALFORMED_PAYLOAD_ACK;
  }
  let claims: RealtimeTokenClaims;
  try {
    claims = await verifyRealtimeToken(parsed.data.token, options.tokenKeys);
  } catch (error) {
    if (error instanceof RealtimeTokenError) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
  const current = socket.data.claims;
  if (claims.org !== current.org || claims.sub !== current.sub) {
    return { ok: false, code: RealtimeErrorCode.Forbidden };
  }
  socket.data.claims = claims;
  armTokenExpiry(state, socket, options.now);
  leaveUngrantedChannels(socket, options.revocations);
  return { ok: true, expiresAt: tokenExpiresAtMs(claims) };
}

type Ack = (response: unknown) => void;

/**
 * socket.io passes the ack callback last. A client that sends a callback and
 * no payload makes the callback the only argument, which reads as a missing
 * payload rather than a payload.
 */
function onAckedEvent(
  socket: RealtimeSocket,
  event: string,
  handle: (payload: unknown) => unknown
): void {
  socket.on(event, (...args: unknown[]) => {
    const last = args.at(-1);
    const ack = isAck(last) ? last : undefined;
    const payload = args[0] === ack ? undefined : args[0];
    Promise.resolve()
      .then(() => handle(payload))
      .then(
        (response) => ack?.(response),
        (error: unknown) => {
          log.error("Realtime event handler failed", {
            event: HANDLER_FAULT_EVENT,
            socketId: socket.id,
            socketEvent: event,
            error: describeFault(error),
          });
          ack?.(MALFORMED_PAYLOAD_ACK);
        }
      );
  });
}

/** Also the answer to a handler that throws: `internal` is the only honest code. */
const MALFORMED_PAYLOAD_ACK: FailureAck = {
  ok: false,
  code: RealtimeErrorCode.Internal,
};

function isAck(value: unknown): value is Ack {
  return typeof value === "function";
}

export const HANDLER_FAULT_EVENT = "realtime.handler_fault";
