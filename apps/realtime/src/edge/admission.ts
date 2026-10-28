import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { RealtimeTokenClaims } from "@repo/realtime-contract/token";
import type { ExtendedError } from "socket.io";
import { recordHandshakeRejection } from "../telemetry/spans";
import {
  HandshakeRejection,
  type HandshakeRejectionCode,
} from "./auth-middleware";
import { describeFault } from "./fault";
import type { RealtimeSocket } from "./socket-server";

export type Admission =
  | { admitted: true; release: () => void }
  | { admitted: false };

/** PLN-2104 step 7: the per-user and per-org connection caps. */
export type ConnectionAdmitter = {
  admit(claims: Pick<RealtimeTokenClaims, "sub" | "org">): Promise<Admission>;
};

/**
 * Runs after the auth middleware, so the claims are verified. A connection
 * over a cap is refused with the retryable `rate_limited`. An admitted one is
 * released exactly once, when the socket disconnects or, for a handshake
 * whose client left before it connected, when its transport closes.
 */
export function createAdmissionMiddleware(admitter: ConnectionAdmitter) {
  return (
    socket: RealtimeSocket,
    next: (error?: ExtendedError) => void
  ): void => {
    const reject = (code: HandshakeRejectionCode) => {
      recordHandshakeRejection(socket.id, code);
      next(new HandshakeRejection(code));
    };
    admitter.admit(socket.data.claims).then(
      (admission) => {
        if (!admission.admitted) {
          reject(RealtimeErrorCode.RateLimited);
          return;
        }
        releaseOnClose(socket, admission.release);
        next();
      },
      (error: unknown) => {
        log.error("Realtime connection admission failed", {
          event: ADMISSION_FAULT_EVENT,
          socketId: socket.id,
          error: describeFault(error),
        });
        reject(RealtimeErrorCode.Internal);
      }
    );
  };
}

function releaseOnClose(socket: RealtimeSocket, release: () => void): void {
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      release();
    }
  };
  if (socket.conn.readyState === CLOSED_TRANSPORT) {
    releaseOnce();
    return;
  }
  socket.once("disconnect", releaseOnce);
  socket.conn.once("close", releaseOnce);
}

const CLOSED_TRANSPORT = "closed";

export const ADMISSION_FAULT_EVENT = "realtime.admission_fault";
