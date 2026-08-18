/**
 * Failure taxonomy for the pre-loop health check (ISS-5169).
 *
 * Before this module every failure collapsed into one opaque reason: a relay
 * round trip that never finished and a target that answered with failing checks
 * produced identical operator-facing text. The two need different remedies —
 * one is a reachability problem the operator cannot fix from the dialog, the
 * other is a concrete remediation list — so they are classified apart here and
 * the classification drives both the analytics reason and the copy.
 */

/** Why a pre-loop health check did not produce a usable verdict. */
export const HealthCheckFailureKind = {
  /** The relay round trip exceeded its per-attempt budget. */
  RelayTimeout: "relay_timeout",
  /** The loopback gateway round trip exceeded its per-attempt budget. */
  LocalTimeout: "local_timeout",
  /** The caller-side backstop fired; the whole check (incl. retries) overran. */
  OverallTimeout: "overall_timeout",
  /** The request never reached a responder (socket/network/CORS failure). */
  Unreachable: "unreachable",
  /** The target is not sending heartbeats, so no check was attempted. */
  TargetOffline: "target_offline",
  /** Anything else — a responder answered, but not usefully. */
  Unknown: "unknown",
} as const;
export type HealthCheckFailureKind =
  (typeof HealthCheckFailureKind)[keyof typeof HealthCheckFailureKind];

/** The relay's own "this target is not connected" status (`/api/gateway-relay`). */
const TARGET_OFFLINE_HTTP_STATUS = 503;

/**
 * Failure kinds that mean "we could not reach this compute target", as opposed
 * to "this compute target answered and reported problems". Only these are
 * eligible for the Cloud fallback (ISS-5171) — a target that answered with real
 * failing checks still deserves the remediation dialog.
 */
const UNREACHABLE_KINDS = new Set<HealthCheckFailureKind>([
  HealthCheckFailureKind.RelayTimeout,
  HealthCheckFailureKind.LocalTimeout,
  HealthCheckFailureKind.OverallTimeout,
  HealthCheckFailureKind.Unreachable,
  HealthCheckFailureKind.TargetOffline,
]);

/**
 * Thrown when a health-check attempt (or the caller-side backstop around it)
 * runs out of budget. Carries the kind so downstream code never has to
 * string-match a message to tell a relay timeout from a local one.
 */
export class HealthCheckTimeoutError extends Error {
  readonly kind: HealthCheckFailureKind;
  readonly timeoutMs: number;

  constructor(kind: HealthCheckFailureKind, timeoutMs: number) {
    super(buildTimeoutMessage(kind, timeoutMs));
    this.name = "HealthCheckTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a responder answered the health check with a non-2xx status.
 *
 * Carrying the status matters because not every non-2xx came from the compute
 * target: the relay route itself answers `503 Compute target offline` when the
 * heartbeat says the target is gone (`/api/gateway-relay`), and a plain `Error`
 * collapses that into `Unknown` — which is neither retried nor eligible for the
 * Cloud fallback, exactly the stale-online/fresh-offline race this PR exists to
 * survive.
 */
export class HealthCheckHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HealthCheckHttpError";
    this.status = status;
  }
}

/** Returns whether a failure means the target could not be reached at all. */
export function isUnreachableHealthCheckFailure(
  kind: HealthCheckFailureKind
): boolean {
  return UNREACHABLE_KINDS.has(kind);
}

/**
 * Classifies an arbitrary health-check rejection. `HealthCheckTimeoutError`
 * self-reports; a bare `AbortError`/`TimeoutError` from `AbortSignal.timeout`
 * or a `TypeError` from `fetch` means nothing answered; everything else came
 * back from a responder and is treated as a real verdict.
 */
export function classifyHealthCheckFailure(
  error: unknown,
  { relayTarget = false }: { relayTarget?: boolean } = {}
): HealthCheckFailureKind {
  if (error instanceof HealthCheckTimeoutError) {
    return error.kind;
  }

  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return relayTarget
      ? HealthCheckFailureKind.RelayTimeout
      : HealthCheckFailureKind.LocalTimeout;
  }

  // The relay answers 503 when the target's heartbeat says it is gone. That is
  // a reachability verdict from our own infrastructure, not a check the target
  // ran and failed, so it must reach the retry and the Cloud fallback.
  if (
    error instanceof HealthCheckHttpError &&
    error.status === TARGET_OFFLINE_HTTP_STATUS
  ) {
    return HealthCheckFailureKind.TargetOffline;
  }

  // `fetch` rejects with a bare TypeError when the request never reached a
  // responder — DNS, socket, or CORS — which is exactly the relay-down case.
  if (error instanceof TypeError) {
    return HealthCheckFailureKind.Unreachable;
  }

  return HealthCheckFailureKind.Unknown;
}

/**
 * Operator-facing copy for a failure kind. Both `targetLabel` variants are
 * produced from one helper so the toast and the dialog cannot drift apart.
 *
 * The dialog already names the target twice — in its description ("Target: X")
 * and in this `title` — so the `description` never names it a third time, and
 * it explains what to do rather than how our transport is wired.
 */
export function describeHealthCheckFailure(
  kind: HealthCheckFailureKind,
  targetLabel?: string | null
): { title: string; description: string } {
  const target = targetLabel?.trim() || "your local machine";

  if (
    kind === HealthCheckFailureKind.RelayTimeout ||
    kind === HealthCheckFailureKind.OverallTimeout
  ) {
    return {
      title: `${target} did not respond`,
      description:
        "Couldn't reach it from here. The desktop app may be closed, or the connection dropped.",
    };
  }

  if (kind === HealthCheckFailureKind.LocalTimeout) {
    return {
      title: "Local gateway did not respond",
      description:
        "The system check timed out reaching the gateway on this machine. Confirm the desktop app is running.",
    };
  }

  if (kind === HealthCheckFailureKind.Unreachable) {
    return {
      title: `Could not reach ${target}`,
      description:
        "Couldn't open a connection from here. Confirm the desktop app is running and connected.",
    };
  }

  if (kind === HealthCheckFailureKind.TargetOffline) {
    return {
      title: `${target} is offline`,
      description:
        "It hasn't checked in recently, so no system check could be run.",
    };
  }

  // `Unknown` is also what a failed latest-release lookup or a throw during
  // target resolution produces — neither of which the machine ever reported.
  // Blaming it here sends the operator off debugging a laptop that is fine, so
  // this title stays neutral. It also cannot advertise Cloud: the Run on Cloud
  // control only exists while `pre-loop-cloud-fallback` is on.
  return {
    title: "System check did not complete",
    description:
      "The system check did not return a result. Re-run it to try again.",
  };
}

function buildTimeoutMessage(
  kind: HealthCheckFailureKind,
  timeoutMs: number
): string {
  if (kind === HealthCheckFailureKind.RelayTimeout) {
    return `Health check timed out reaching the relay target after ${timeoutMs}ms`;
  }
  if (kind === HealthCheckFailureKind.OverallTimeout) {
    return `Health check exceeded its overall budget of ${timeoutMs}ms`;
  }
  return `Health check timed out after ${timeoutMs}ms`;
}
