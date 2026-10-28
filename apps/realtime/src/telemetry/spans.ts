import {
  type Attributes,
  type Context,
  isSpanContextValid,
  ROOT_CONTEXT,
  type SpanContext,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import type { JoinOutcome } from "../edge/channels";
import type { RealtimeSocket } from "../edge/socket-server";
import type { InternalAuth } from "../http/internal";

/**
 * PLN-2104 step 10: one span per unit of work. Org, user and connection ids
 * are span attributes only, never metric tags (ISS-11210 requirement 15). No
 * token and no payload content is ever an attribute.
 */
export const RealtimeSpan = {
  Connection: "realtime.connection",
  ConnectionAdmitted: "realtime.connection_admitted",
  HandshakeRejected: "realtime.handshake_rejected",
  Join: "realtime.join",
  JoinRejected: "realtime.join_rejected",
  SignalFanOut: "realtime.signal_fanout",
  ListenReconnect: "realtime.listen_reconnect",
  Resync: "realtime.resync",
  InternalRequest: "realtime.internal_request",
  BusApply: "realtime.bus_apply",
} as const;

export const RealtimeSpanAttribute = {
  ConnectionId: "realtime.connection_id",
  OrgId: "realtime.org_id",
  UserId: "realtime.user_id",
  ClientVersion: "realtime.client_version",
  ChannelKind: "realtime.channel.kind",
  Code: "realtime.code",
  DisconnectReason: "realtime.disconnect_reason",
  SignalType: "realtime.signal.type",
  Recipients: "realtime.signal.recipients",
  EmitToDeliveryMs: "realtime.signal.emit_to_delivery_ms",
  /** The emitting request's traceparent sampled flag; set only when `tp` is valid. */
  TraceparentSampled: "realtime.signal.traceparent_sampled",
  Outcome: "realtime.outcome",
  Cause: "realtime.cause",
  Attempts: "realtime.attempts",
  InternalPath: "realtime.internal.path",
  HttpStatus: "realtime.internal.http_status",
  /** How an internal request authenticated, an `InternalAuth` (ISS-11966 item 2). */
  InternalAuth: "realtime.internal.auth",
  BusOp: "realtime.bus.op",
  RevokeTarget: "realtime.revoke.target",
  Sockets: "realtime.sockets",
} as const;

export const FanOutOutcome = {
  Delivered: "delivered",
  NoRecipients: "no_recipients",
  Dropped: "dropped",
} as const;
export type FanOutOutcome = (typeof FanOutOutcome)[keyof typeof FanOutOutcome];

/**
 * Records a point span for the admission, then opens the lifetime span the
 * returned function ends. The point span ends at once, so it reaches the next
 * batch export while the connection lasts, and a kill that loses every open
 * lifetime span loses at most the unexported batch of these (operator
 * decision 2026-09-30, PR #8191).
 */
export function startConnectionSpan(
  socket: RealtimeSocket
): (disconnectReason: string) => void {
  const attributes: Attributes = {
    ...socketAttributes(socket),
    [RealtimeSpanAttribute.ClientVersion]: socket.data.clientVersion.slice(
      0,
      MAX_CLIENT_VERSION_LENGTH
    ),
  };
  tracer().startSpan(RealtimeSpan.ConnectionAdmitted, { attributes }).end();
  const span = tracer().startSpan(RealtimeSpan.Connection, { attributes });
  return (disconnectReason) => {
    span.setAttribute(RealtimeSpanAttribute.DisconnectReason, disconnectReason);
    span.end();
  };
}

export function recordHandshakeRejection(socketId: string, code: string): void {
  tracer()
    .startSpan(RealtimeSpan.HandshakeRejected, {
      attributes: {
        [RealtimeSpanAttribute.ConnectionId]: socketId,
        [RealtimeSpanAttribute.Code]: code,
      },
    })
    .end();
}

/**
 * Opened before the join's checks run. The kind comes from the address the
 * join parsed, so a kind the service has never seen is recorded as sent.
 */
export function startJoinSpan(
  socket: RealtimeSocket
): (outcome: JoinOutcome) => void {
  const span = tracer().startSpan(RealtimeSpan.Join, {
    attributes: socketAttributes(socket),
  });
  return ({ ack, kind }) => {
    if (kind !== undefined) {
      span.setAttribute(RealtimeSpanAttribute.ChannelKind, kind);
    }
    if (!ack.ok) {
      span.updateName(RealtimeSpan.JoinRejected);
      span.setAttribute(RealtimeSpanAttribute.Code, ack.code);
    }
    span.end();
  };
}

export type SignalFanOutRecord =
  | {
      outcome: typeof FanOutOutcome.Dropped;
      /** The contract's rejection reason; never the payload. */
      reason: string;
    }
  | {
      outcome:
        | typeof FanOutOutcome.Delivered
        | typeof FanOutOutcome.NoRecipients;
      /** Read from the envelope's channel address, never from a list. */
      kind: string | undefined;
      type: string;
      /** The local room size. */
      recipients: number;
      /** Absent when this clock reads earlier than the emitter's. */
      emitToDeliveryMs: number | undefined;
      traceparent: string | undefined;
    };

/**
 * PLN-2105 step 2: one span per notification. With a valid `tp` it is a child
 * of the emitting write's span, so the write and its delivery are one trace
 * (ISS-11210 requirement 17 and AC7).
 */
export function recordSignalFanOut(record: SignalFanOutRecord): void {
  const attributes: Attributes = {
    [RealtimeSpanAttribute.Outcome]: record.outcome,
  };
  let parent: Context | undefined;
  if (record.outcome === FanOutOutcome.Dropped) {
    attributes[RealtimeSpanAttribute.Code] = record.reason;
  } else {
    attributes[RealtimeSpanAttribute.SignalType] = record.type;
    attributes[RealtimeSpanAttribute.Recipients] = record.recipients;
    if (record.kind !== undefined) {
      attributes[RealtimeSpanAttribute.ChannelKind] = record.kind;
    }
    if (record.emitToDeliveryMs !== undefined) {
      attributes[RealtimeSpanAttribute.EmitToDeliveryMs] =
        record.emitToDeliveryMs;
    }
    const emitter = traceparentSpanContext(record.traceparent);
    if (emitter) {
      attributes[RealtimeSpanAttribute.TraceparentSampled] =
        // biome-ignore lint/suspicious/noBitwiseOperators: W3C trace flags are a bit field, and sampled is one bit of it.
        (emitter.traceFlags & TraceFlags.SAMPLED) !== 0;
      // ISS-11210 ask 2: recorded whatever the emitter's sampling decision, and
      // the flag is only the attribute above. The parent-based sampler drops a
      // child of an unsampled remote parent, so the parent is marked sampled.
      parent = trace.setSpanContext(ROOT_CONTEXT, {
        ...emitter,
        traceFlags: TraceFlags.SAMPLED,
      });
    }
  }
  tracer().startSpan(RealtimeSpan.SignalFanOut, { attributes }, parent).end();
}

/** Why the server sent `rt:resync`. */
export const ResyncCause = {
  /** LISTEN came back after a loss, so signals sent in the gap are gone. */
  ListenResumed: "listen_resumed",
} as const;
export type ResyncCause = (typeof ResyncCause)[keyof typeof ResyncCause];

/**
 * ISS-11210 requirement 16: one span per server-sent resync, with its cause
 * and how many sockets it reached.
 */
export function recordResync(cause: ResyncCause, sockets: number): void {
  tracer()
    .startSpan(RealtimeSpan.Resync, {
      attributes: {
        [RealtimeSpanAttribute.Cause]: cause,
        [RealtimeSpanAttribute.Sockets]: sockets,
      },
    })
    .end();
}

/** PLN-2105 step 1: spans the gap from the loss to LISTEN running again. */
export function recordListenReconnect(
  cause: string,
  lostAt: number,
  attempts: number
): void {
  tracer()
    .startSpan(RealtimeSpan.ListenReconnect, {
      startTime: lostAt,
      attributes: {
        [RealtimeSpanAttribute.Cause]: cause,
        [RealtimeSpanAttribute.Attempts]: attempts,
      },
    })
    .end();
}

export type InternalRequestRecord = {
  path: string;
  status: number;
  /** Read from a valid publish body's channel address. */
  kind?: string;
  type?: string;
  /** Which field a valid revoke body targets; never its value. */
  revokeTarget?: string;
  auth?: InternalAuth;
  /** Why a presented bearer token was rejected: a claim name or error code, never the token. */
  oidcRejection?: string;
};

/** PLN-2105 step 6: one span per internal publish or revoke request, whatever its answer. */
export function recordInternalRequest(record: InternalRequestRecord): void {
  const attributes: Attributes = {
    [RealtimeSpanAttribute.InternalPath]: record.path,
    [RealtimeSpanAttribute.HttpStatus]: record.status,
  };
  if (record.kind !== undefined) {
    attributes[RealtimeSpanAttribute.ChannelKind] = record.kind;
  }
  if (record.type !== undefined) {
    attributes[RealtimeSpanAttribute.SignalType] = record.type;
  }
  if (record.revokeTarget !== undefined) {
    attributes[RealtimeSpanAttribute.RevokeTarget] = record.revokeTarget;
  }
  if (record.auth !== undefined) {
    attributes[RealtimeSpanAttribute.InternalAuth] = record.auth;
  }
  if (record.oidcRejection !== undefined) {
    attributes[RealtimeSpanAttribute.Cause] = record.oidcRejection;
  }
  tracer().startSpan(RealtimeSpan.InternalRequest, { attributes }).end();
}

/** PLN-2105 step 5: one span per bus message this instance applies. */
export function recordBusApply(
  op: string,
  sockets: number,
  revokeTarget?: string
): void {
  const attributes: Attributes = {
    [RealtimeSpanAttribute.BusOp]: op,
    [RealtimeSpanAttribute.Sockets]: sockets,
  };
  if (revokeTarget !== undefined) {
    attributes[RealtimeSpanAttribute.RevokeTarget] = revokeTarget;
  }
  tracer().startSpan(RealtimeSpan.BusApply, { attributes }).end();
}

function traceparentSpanContext(
  traceparent: string | undefined
): SpanContext | undefined {
  const match = traceparent?.match(TRACEPARENT_PATTERN);
  if (!match) {
    return undefined;
  }
  const [, traceId, spanId, flags] = match;
  const context = {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
  };
  return isSpanContextValid(context) ? context : undefined;
}

/** W3C trace context version 00, as `emitSignal` writes it. */
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function socketAttributes(socket: RealtimeSocket): Attributes {
  return {
    [RealtimeSpanAttribute.ConnectionId]: socket.id,
    [RealtimeSpanAttribute.OrgId]: socket.data.claims.org,
    [RealtimeSpanAttribute.UserId]: socket.data.claims.sub,
  };
}

function tracer() {
  return trace.getTracer(REALTIME_TRACER_NAME);
}

const REALTIME_TRACER_NAME = "closedloop.realtime";

/** The handshake's `clientVersion` is client-chosen and only checked nonempty. */
export const MAX_CLIENT_VERSION_LENGTH = 64;
