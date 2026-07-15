import { shortContentHash } from "./content-hash";

/**
 * Shape of the short hash {@link redactGatewaySessionId} emits (a 12-char hex
 * digest from {@link shortContentHash}). Exported so tests and schemas assert the
 * redacted format from one source instead of redeclaring the pattern.
 */
export const SHORT_HASH_PATTERN = /^[0-9a-f]{12}$/;

/**
 * Redact a desktop gateway WebSocket session id before it reaches any log or
 * telemetry sink.
 *
 * The raw `gatewaySessionId` is a session-correlation token (see
 * `apps/api/docs/command-correlation.md`) that must never be logged or exposed in
 * client-facing responses. Every log/telemetry sink emits a short stable hash
 * instead: the same raw id always hashes to the same value, so telemetry events
 * for one session still correlate to each other by the hashed id without leaking
 * the token. The raw value is kept only in non-log, non-telemetry contracts (the
 * desktop-command store / DB context and the PostHog analytics property) that
 * legitimately join on the real id.
 *
 * Returns null when there is no session id, mirroring how other optional
 * correlation fields log `?? null`.
 */
export function redactGatewaySessionId(
  gatewaySessionId: string | null | undefined
): string | null {
  return shortContentHash(gatewaySessionId);
}

/**
 * Return a shallow copy of a telemetry trace with its `gatewaySessionId` replaced
 * by the redacted hash, ready to hand to a log/telemetry sink. Generic over the
 * trace shape so this module stays decoupled from the telemetry schema. An absent
 * `gatewaySessionId` (e.g. a desktop trace before hello-ack) is left untouched.
 */
export function redactTraceGatewaySessionId<
  T extends { gatewaySessionId?: string },
>(trace: T): T {
  if (trace.gatewaySessionId === undefined) {
    return trace;
  }
  return {
    ...trace,
    gatewaySessionId:
      redactGatewaySessionId(trace.gatewaySessionId) ?? undefined,
  };
}
