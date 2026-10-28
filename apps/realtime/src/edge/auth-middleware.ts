import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { handshakeAuthSchema } from "@repo/realtime-contract/protocol";
import {
  type RealtimeTokenClaims,
  RealtimeTokenError,
  type RealtimeTokenVerifyOptions,
  verifyRealtimeToken,
} from "@repo/realtime-contract/token";
import type { ExtendedError } from "socket.io";
import { z } from "zod";
import { recordHandshakeRejection } from "../telemetry/spans";
import { describeFault } from "./fault";
import type { RealtimeSocket } from "./socket-server";

export type HandshakeRejectionCode =
  | typeof RealtimeErrorCode.Unauthorized
  | typeof RealtimeErrorCode.TokenExpired
  | typeof RealtimeErrorCode.UnknownKind
  | typeof RealtimeErrorCode.RateLimited
  | typeof RealtimeErrorCode.Internal;

/** socket.io delivers `data` to the client's `connect_error` handler. */
export class HandshakeRejection extends Error implements ExtendedError {
  readonly data: { code: HandshakeRejectionCode };

  constructor(code: HandshakeRejectionCode) {
    super(code);
    this.name = "HandshakeRejection";
    this.data = { code };
  }
}

export type AuthMiddlewareOptions = {
  tokenKeys: RealtimeTokenVerifyOptions;
  isDraining: () => boolean;
};

/**
 * PLN-2104 decision 2. Reads only `socket.handshake.auth`, never the query
 * string, so a token cannot arrive in a URL. Checks run token first, so an
 * unauthenticated caller learns nothing about protocol support. A draining
 * instance refuses every handshake with the retryable `rate_limited`, before
 * any token work.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  return (
    socket: RealtimeSocket,
    next: (error?: ExtendedError) => void
  ): void => {
    const reject = (code: HandshakeRejectionCode) => {
      recordHandshakeRejection(socket.id, code);
      next(new HandshakeRejection(code));
    };
    if (options.isDraining()) {
      reject(RealtimeErrorCode.RateLimited);
      return;
    }
    authenticate(socket, options).then(
      (code) => (code === undefined ? next() : reject(code)),
      (error: unknown) => {
        log.error("Realtime handshake failed", {
          event: HANDSHAKE_FAULT_EVENT,
          socketId: socket.id,
          error: describeFault(error),
        });
        reject(RealtimeErrorCode.Internal);
      }
    );
  };
}

/**
 * `handshakeAuthSchema` is parsed field by field because each field failing
 * answers a different code.
 */
async function authenticate(
  socket: RealtimeSocket,
  options: AuthMiddlewareOptions
): Promise<HandshakeRejectionCode | undefined> {
  const auth = HANDSHAKE_AUTH_RECORD.parse(socket.handshake.auth);
  const fields = handshakeAuthSchema.shape;
  const token = fields.token.safeParse(auth.token);
  if (!token.success) {
    return RealtimeErrorCode.Unauthorized;
  }
  let claims: RealtimeTokenClaims;
  try {
    claims = await verifyRealtimeToken(token.data, options.tokenKeys);
  } catch (error) {
    if (error instanceof RealtimeTokenError) {
      return error.code;
    }
    throw error;
  }
  // An unsupported protocol maps to `unknown_kind` (PLN-2104 decision 2).
  if (!fields.protocol.safeParse(auth.protocol).success) {
    return RealtimeErrorCode.UnknownKind;
  }
  const clientVersion = fields.clientVersion.safeParse(auth.clientVersion);
  if (!clientVersion.success) {
    return RealtimeErrorCode.Unauthorized;
  }
  socket.data.claims = claims;
  socket.data.clientVersion = clientVersion.data;
  return undefined;
}

const HANDSHAKE_AUTH_RECORD = z.record(z.string(), z.unknown()).catch({});

export const HANDSHAKE_FAULT_EVENT = "realtime.handshake_fault";
