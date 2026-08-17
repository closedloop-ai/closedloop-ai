import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";

/** What the desktop should say and do about a received hello rejection. */
export type DesktopHelloNackDisposition = {
  /**
   * The recognized wire reason, or `null` when the nack carried no reason, a
   * non-string one, or one this build has never heard of.
   *
   * Deliberately narrowed to the enum: the payload crosses an untrusted,
   * version-skewed wire, and the only strings this module lets reach the status
   * bar or the gateway log are ones this build authored. A raw wire reason is
   * never echoed, so CR/LF and terminal control bytes in it have nowhere to go.
   */
  reason: DesktopHelloNackReason | null;
  /** `false` for an absent or unrecognized reason from a version-skewed cloud. */
  recognized: boolean;
  /**
   * Length of the raw wire reason (0 when absent or non-string). Bounded,
   * non-content metadata: enough to tell a truncated field from a garbage blob
   * in a support log without logging the blob itself.
   */
  reasonLength: number;
  /** Shown to the user as `CloudSocketStatus.error`. */
  message: string;
};

/**
 * Reads a `desktop.hello.nack` payload and decides what the user is told.
 *
 * Deliberately tolerant: the payload crosses a version-skewed wire boundary, so
 * a missing reason, a non-string reason, or a reason this build has never heard
 * of all resolve to the generic surfaced message rather than throwing.
 *
 * Retryability is NOT derived here, and no reason is treated as permanent. Every
 * `DesktopHelloNackReason` the cloud can send is produced by `runStage` in
 * `apps/api/lib/with-timeout.ts`, whose hello call sites pass no distinct
 * `failureReason` — so the same reason means "the 5s stage deadline expired" and
 * "the stage threw", and the wire carries nothing that separates them. The
 * reconnect policy is therefore uniform and streak-based (see
 * `HELLO_NACK_BACKOFF_THRESHOLD` in `cloud-socket.ts`): a transient cloud
 * slowdown recovers at the normal cadence, and an unrecognized or malformed
 * reason from a newer cloud still ends up bounded instead of hammering
 * `desktop.hello` forever. See ISS-6126.
 */
export function describeDesktopHelloNack(
  payload: unknown
): DesktopHelloNackDisposition {
  const rawReason = readReason(payload);
  // `Object.hasOwn`, not a bare index: the reason crosses an untrusted wire, so
  // a plain-object lookup on `"constructor"` or `"toString"` would resolve up
  // the prototype chain to a truthy non-message and be reported as RECOGNIZED
  // with an undefined message.
  const recognized =
    rawReason !== null && Object.hasOwn(HELLO_NACK_MESSAGES, rawReason);
  if (recognized) {
    const reason = rawReason as DesktopHelloNackReason;
    return {
      reason,
      recognized: true,
      reasonLength: (rawReason as string).length,
      message: HELLO_NACK_MESSAGES[reason],
    };
  }

  return {
    reason: null,
    recognized: false,
    reasonLength: rawReason?.length ?? 0,
    message: UNRECOGNIZED_HELLO_NACK_MESSAGE,
  };
}

/**
 * Appends the pause the desktop is about to take before its next handshake, so
 * a user reading a stalled status bar knows the app has not simply given up.
 */
export function withReconnectPauseNotice(
  message: string,
  delayMs: number
): string {
  return `${message} Paused for ${Math.round(delayMs / 1000)}s before the next attempt.`;
}

function readReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const reason = (payload as Record<string, unknown>).reason;
  if (typeof reason !== "string") {
    return null;
  }
  return reason.trim() || null;
}

/**
 * Exported so a test can assert distinctness and coverage against the SHIPPED
 * table rather than against a hand-copied fixture that cannot fail. A new member
 * of `DesktopHelloNackReason` fails `tsc` here until it is given wording.
 */
export const HELLO_NACK_MESSAGES: Record<DesktopHelloNackReason, string> = {
  [DesktopHelloNackReason.ComputeTargetRegisterFailed]:
    "Cloud could not register this machine (compute_target_register_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  [DesktopHelloNackReason.ComputeTargetUpdateFailed]:
    "Cloud could not update this machine's registration (compute_target_update_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  [DesktopHelloNackReason.OnlineStateUpdateFailed]:
    "Cloud could not mark this machine online (online_state_update_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  [DesktopHelloNackReason.PendingCommandsLookupFailed]:
    "Cloud could not load this machine's pending commands (pending_commands_lookup_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  [DesktopHelloNackReason.InternalError]:
    "Cloud hit an internal error while accepting this machine (internal_error). Reconnecting — if this keeps happening, check ClosedLoop status.",
};

/**
 * Shown for a nack whose reason is absent, non-string, or unknown to this build.
 *
 * States only what is observed and names no wire content. The reason itself is
 * never interpolated: an older desktop cannot render a newer cloud's reason
 * meaningfully anyway, and echoing an attacker- or corruption-controlled string
 * into the status bar, the raw console sink, and persistent diagnostics is a log
 * and UI injection surface that a length cap does not close.
 */
export const UNRECOGNIZED_HELLO_NACK_MESSAGE =
  "Cloud rejected this machine for a reason this version does not recognize. Reconnecting — update the desktop app if this keeps happening.";

/**
 * Shown when the cloud closes the connection after `desktop.hello` without
 * sending any `desktop.hello.nack` at all. Two server paths do this — a gateway
 * conflict and an unparseable hello — and neither is otherwise visible from the
 * desktop, so this must stay distinguishable from a plain network drop.
 *
 * The wording deliberately states only what is observed and offers the likely
 * cause conditionally. `io server disconnect` is Socket.IO's reason for ANY
 * server-initiated close, so a deploy or connection drain that lands inside the
 * handshake window reaches this branch too; naming a duplicate gateway ID as
 * the cause outright would hand that user a confident, wrong diagnosis.
 */
export const HELLO_REJECTED_WITHOUT_REASON_MESSAGE =
  "Cloud closed the connection during the handshake without saying why. Reconnecting — if this keeps happening, another machine may be registered with the same gateway ID.";

/** Socket.IO's own reason string for a server-initiated close. */
export const SERVER_INITIATED_DISCONNECT_REASON = "io server disconnect";

/** Log-safe stand-in for a reason field that carried nothing usable. */
export const ABSENT_HELLO_NACK_REASON_LABEL = "(absent)";

/** Log-safe stand-in for a reason this build does not recognize. */
export const UNRECOGNIZED_HELLO_NACK_REASON_LABEL = "(unrecognized)";

/**
 * The reason token safe to write to the gateway log: the recognized enum member,
 * or a fixed label. Never the raw wire string.
 */
export function helloNackReasonLogToken(
  disposition: DesktopHelloNackDisposition
): string {
  if (disposition.reason) {
    return disposition.reason;
  }
  return disposition.reasonLength > 0
    ? UNRECOGNIZED_HELLO_NACK_REASON_LABEL
    : ABSENT_HELLO_NACK_REASON_LABEL;
}
