/**
 * @file auth-failure-telemetry.ts
 * @description ISS-6334 (PRD-650 issue 1): the desktop auth/pairing failure
 * signal, and the one thing that makes it worth having — it rides Pipe 1, the
 * UNAUTHENTICATED relay socket, not the authenticated `POST /desktop/telemetry`
 * lane every other diagnostic uses.
 *
 * The bootstrap paradox this closes: a customer who can never pair produces no
 * sessions, no imports and no sync, so every other stream in PRD-650 stays
 * silent for them. The `connection.degraded` event that would say so is gated
 * on `isHttpReady()` in `observability-lane-router.ts` — it needs exactly the
 * auth that just failed — and a 401 on that POST is swallowed. Routing these
 * three failures onto the keyless pipe is the only way the cloud hears about an
 * install that never got in.
 *
 * SECURITY. This is an unauthenticated ingress, so the payload is treated as a
 * trust boundary rather than a convenience:
 * - Closed enums only ({@link AuthOutcome} × {@link AuthReason}). No free text,
 *   no error message, no server response body, and no raw wire reason is ever
 *   echoed — unrecognized input maps to {@link AuthReason.Unknown}.
 * - No credential material of any kind: not the token that failed, not a
 *   prefix, not its length, not a hash. A failed-auth event must not describe
 *   the secret it failed with.
 * - No identifiers and no paths, so there is nothing for the exception
 *   sanitizer to redact: the two enum attributes cannot carry an email
 *   (ISS-6228) or a `file://` install path (ISS-6229) in the first place, and
 *   the contract's `.strict()` parse in {@link buildAuthFailureRecord} is what
 *   enforces that rather than a scrub applied after the fact. That parse binds
 *   the LOG RECORD only; the OTLP Resource is a second, independent carrier
 *   that the serializer stamps onto every export, and the SDK's shared one
 *   holds `app.installation.id` and `device.id`. So these records are re-keyed
 *   onto an allow-listed, de-identified Resource at the export boundary — see
 *   `DEIDENTIFIED_RESOURCE_ATTRIBUTES` in `telemetry/relay-otlp-exporters.ts`,
 *   which is keyed on {@link AUTH_FAILURE_LOGGER_NAME}.
 * - Bounded volume: see {@link createAuthFailureTelemetry}. A client wedged in
 *   a reconnect loop must not be able to amplify itself against the pipe.
 *
 * No relay change is required and none is made: the relay forwards an opaque
 * OTLP body, so this widens nothing about what the ingress accepts.
 */
import {
  type AppTelemetry,
  AppTelemetrySchema,
  AuthOutcome,
  AuthReason,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { DesktopSignInFraming } from "@repo/api/src/types/desktop-authorize-url";
import type { DesktopBrowserSignInFailure } from "../../shared/contracts.js";
import { DesktopSessionRequestError } from "../session/desktop-session-client.js";

/**
 * Record name for every auth-failure signal.
 *
 * NOT a field a cloud query can key on: the desktop OTLP descriptor
 * (`main/otlp/proto-descriptor.ts`) declares no LogRecord `event_name`, so the
 * name is dropped at encode time and only the local-buffer path preserves it.
 * A Datadog monitor keys on the `auth.outcome` attribute, or on the
 * {@link AUTH_FAILURE_LOGGER_NAME} instrumentation scope.
 */
export const AUTH_FAILURE_EVENT_NAME = "auth.failure";
/** Instrumentation scope these records are emitted under. */
export const AUTH_FAILURE_LOGGER_NAME = "closedloop-desktop-auth";

/**
 * Re-emit window for one `outcome:reason` pair. A rejected hello reconnects on
 * a streak-based back-off and a refresh can be retried per request, so an
 * un-deduped emit would let one wedged install flood an ingress that asks it
 * for no credential. Long enough to bound that; short enough that a persistent
 * failure keeps showing up rather than going quiet after its first report.
 */
export const AUTH_FAILURE_DEDUPE_WINDOW_MS = 5 * 60_000;

/** One desktop auth-failure record. Closed enums only — see the file header. */
export type DesktopAuthFailureEventInput = {
  outcome: AuthOutcome;
  reason: AuthReason;
};

/** The name + validated attributes to emit for one auth-failure record. */
export type DesktopAuthFailureRecord = {
  name: string;
  attributes: AppTelemetry;
};

/**
 * Transport-level delivery evidence, sampled when a record is emitted and read
 * again on the next report. Cumulative and monotonic; only the DELTA between
 * two samples is ever interpreted.
 */
export type AuthFailureDeliveryCounters = {
  /** Exports the transport confirmed on the wire. */
  sent: number;
  /** Exports the transport declined, across every drop cause. */
  dropped: number;
};

export type AuthFailureTelemetryOptions = {
  /**
   * Best-effort emit into the app-OTel runtime (which swallows internally).
   * Returns whether the record actually reached the SDK: the runtime silently
   * no-ops when it is not `Started`, and a drop must NOT consume the dedupe
   * window — that would hide the failure for the next window on exactly the
   * install whose telemetry runtime also failed to come up.
   */
  emit: (input: DesktopAuthFailureEventInput) => boolean;
  /**
   * Relay-transport counters, if this build has egress at all. Reaching the SDK
   * is not delivery — the exporter is async and batched, and the relay leg can
   * still decline the batch. See {@link createAuthFailureTelemetry}. Omitted
   * off-prod, where there is no transport and the window alone applies.
   */
  getDeliveryCounters?: () => AuthFailureDeliveryCounters;
  /** Injectable clock for deterministic dedupe-window tests. */
  now?: () => number;
};

export type AuthFailureTelemetry = {
  /** Report one auth failure, subject to the dedupe window. */
  report: (input: DesktopAuthFailureEventInput) => void;
};

/**
 * Build the log-record payload for `input`.
 *
 * The contract's `.strict()` closed-world parse is the enforcement point: only
 * `auth.outcome` and `auth.reason` can ship, so a regression that tried to
 * attach a token, a path, or a user id throws here rather than leaking it onto
 * an unauthenticated pipe. Throwing is intended — the caller swallows, per the
 * desktop exporter-boundary rule.
 */
export function buildAuthFailureRecord(
  input: DesktopAuthFailureEventInput
): DesktopAuthFailureRecord {
  return {
    name: AUTH_FAILURE_EVENT_NAME,
    attributes: AppTelemetrySchema.parse({
      [TelemetryAttribute.AuthOutcome]: input.outcome,
      [TelemetryAttribute.AuthReason]: input.reason,
    }),
  };
}

/**
 * Map a `desktop.hello.nack` disposition onto the closed reason set.
 *
 * `describeDesktopHelloNack` already narrows an absent, non-string, or
 * unrecognized wire reason to `null` and never surfaces the raw string, so
 * `null` here is the version-skew case and collapses to
 * {@link AuthReason.Unknown} — an older desktop reports that a newer cloud
 * refused it without inventing a label for why.
 */
export function authReasonForHelloNack(
  reason: DesktopHelloNackReason | null
): AuthReason {
  return lookupAuthReason(HELLO_NACK_AUTH_REASON, reason);
}

/** Map a desktop session-endpoint error onto the closed reason set. */
export function authReasonForSessionRequestError(
  error: DesktopSessionRequestError
): AuthReason {
  return lookupAuthReason(SESSION_REQUEST_AUTH_REASON, error);
}

/**
 * Wrap `emit` with the volume bound.
 *
 * Dedupe is keyed on the whole `outcome:reason` pair, so a CHANGED reason is
 * never suppressed — it is a different key and reports immediately, which is
 * what keeps the bound from hiding an install whose failure mode moved. The
 * same pair re-reports once per {@link AUTH_FAILURE_DEDUPE_WINDOW_MS}.
 *
 * REACHING THE SDK IS NOT DELIVERY. The exporter is async and batched, so a
 * record accepted here can still be declined by the relay leg afterwards —
 * cooldown, rate limit, a rejected session, an unavailable collector. Spending
 * the window on that would silence the pair for the rest of it even though
 * nothing arrived, on exactly the population whose network is already the
 * problem. So the window is additionally re-armed by PROOF of non-delivery:
 * `sent` unchanged since the emit means nothing at all left the process, and a
 * `dropped` that advanced in that same span means the transport actively
 * refused. Both together, never either alone — absence of a send during the
 * normal batch delay is not evidence of a drop, and treating it as one would
 * let a reconnect loop re-emit against the very bound this exists to hold.
 *
 * The key map cannot grow without bound: keys are drawn from the closed
 * {@link AuthOutcome} × {@link AuthReason} product, so its size is capped at
 * that product by the contract itself — there is no external input that can
 * mint a key. A widening of either enum is a deliberate contract edit, and the
 * cap moves with it.
 */
export function createAuthFailureTelemetry(
  options: AuthFailureTelemetryOptions
): AuthFailureTelemetry {
  const now = options.now ?? Date.now;
  const lastEmitted = new Map<string, AuthFailureEmitMark>();

  return {
    report(input) {
      const key = `${input.outcome}:${input.reason}`;
      const at = now();
      const previous = lastEmitted.get(key);
      if (previous !== undefined && isSuppressed(previous, at, options)) {
        return;
      }
      // Recorded only on a confirmed emit, so a runtime that was not started
      // does not spend the window on a record nobody received.
      if (options.emit(input)) {
        lastEmitted.set(key, { at, delivery: options.getDeliveryCounters?.() });
      }
    },
  };
}

/**
 * Exhaustive by construction: a new `DesktopHelloNackReason` fails `tsc` here
 * until it is deliberately given a closed telemetry reason, so a cloud-side
 * addition can never reach the wire as an unmapped passthrough.
 */
const HELLO_NACK_AUTH_REASON: Record<DesktopHelloNackReason, AuthReason> = {
  [DesktopHelloNackReason.ComputeTargetRegisterFailed]:
    AuthReason.ComputeTargetRegisterFailed,
  [DesktopHelloNackReason.ComputeTargetUpdateFailed]:
    AuthReason.ComputeTargetUpdateFailed,
  [DesktopHelloNackReason.OnlineStateUpdateFailed]:
    AuthReason.OnlineStateUpdateFailed,
  [DesktopHelloNackReason.PendingCommandsLookupFailed]:
    AuthReason.PendingCommandsLookupFailed,
  [DesktopHelloNackReason.InternalError]: AuthReason.CloudInternalError,
};

/** Same exhaustiveness guard for the desktop session endpoints. */
const SESSION_REQUEST_AUTH_REASON: Record<
  DesktopSessionRequestError,
  AuthReason
> = {
  [DesktopSessionRequestError.PopUnavailable]: AuthReason.PopUnavailable,
  [DesktopSessionRequestError.PopRejected]: AuthReason.PopRejected,
  [DesktopSessionRequestError.AlreadyUsed]: AuthReason.AlreadyUsed,
  [DesktopSessionRequestError.OrgRequired]: AuthReason.OrgRequired,
  [DesktopSessionRequestError.Invalid]: AuthReason.CredentialInvalid,
  [DesktopSessionRequestError.BadRequest]: AuthReason.BadRequest,
  [DesktopSessionRequestError.Unavailable]: AuthReason.ServerUnavailable,
  [DesktopSessionRequestError.Network]: AuthReason.NetworkUnreachable,
};

/**
 * `Object.hasOwn` before the index, per the repo rule for dispatch tables read
 * with a key that originates off a version-skewed wire: a bare lookup on
 * `"constructor"` or `"toString"` would resolve up the prototype chain and
 * return a function as the reason. Unmapped or prototype-borne keys collapse to
 * the generic fallback instead.
 */
function lookupAuthReason(
  table: Record<string, AuthReason>,
  key: string | null
): AuthReason {
  if (key === null || !Object.hasOwn(table, key)) {
    return AuthReason.Unknown;
  }
  return table[key];
}

/** When a pair was last emitted, and the transport's counters at that moment. */
type AuthFailureEmitMark = {
  at: number;
  delivery: AuthFailureDeliveryCounters | undefined;
};

/**
 * True while `key` is still inside its re-emit window. A NEGATIVE elapsed —
 * a backwards NTP correction on a freshly provisioned machine, which is exactly
 * the population most likely to be failing to pair — counts as expired rather
 * than suppressing the signal until the wall clock catches up.
 */
function isWithinDedupeWindow(previousAt: number, at: number): boolean {
  const elapsedMs = at - previousAt;
  return elapsedMs >= 0 && elapsedMs < AUTH_FAILURE_DEDUPE_WINDOW_MS;
}

/** Suppress only inside the window AND with the previous record unrefuted. */
function isSuppressed(
  previous: AuthFailureEmitMark,
  at: number,
  options: AuthFailureTelemetryOptions
): boolean {
  return (
    isWithinDedupeWindow(previous.at, at) &&
    !hasTransportRefusedSince(previous, options.getDeliveryCounters?.())
  );
}

/**
 * Proof that the marked record never made it off the machine.
 *
 * Both counters are cumulative, so this reads their delta since the emit. A
 * build with no transport, or a first sample taken before one existed, has
 * nothing to prove non-delivery with and answers `false` — the window then
 * behaves exactly as it did before, which is the safe direction: it suppresses
 * a duplicate rather than releasing one on a guess.
 */
function hasTransportRefusedSince(
  previous: AuthFailureEmitMark,
  current: AuthFailureDeliveryCounters | undefined
): boolean {
  if (!(previous.delivery && current)) {
    return false;
  }
  return (
    current.sent === previous.delivery.sent &&
    current.dropped > previous.delivery.dropped
  );
}

/** ISS-11394: the callback's accountCreated identifies the exchange arm. */
export function signInExchangeFailedOutcome(
  accountCreated: boolean
): AuthOutcome {
  return accountCreated
    ? AuthOutcome.SignUpExchangeFailed
    : AuthOutcome.SignInExchangeFailed;
}

/** ISS-11394: without a trusted callback, only the requested framing is known. */
export function signInRedirectFailedOutcome(
  framing: DesktopSignInFraming | undefined
): AuthOutcome {
  return framing === DesktopSignInFraming.SignUp
    ? AuthOutcome.SignUpRedirectFailed
    : AuthOutcome.SignInRedirectFailed;
}

/**
 * ISS-11394: the `auth.reason` for a browser sign-in that ended without a
 * usable callback, or `null` when the failure is not that (a cancellation,
 * which must not spend the replacement run's dedupe slot, or an exchange
 * failure, reported on its own path). Each cause has its own reason so the
 * signal splits in Datadog and the dedupe window is per cause.
 */
export function signInRedirectFailureReason(
  failure: DesktopBrowserSignInFailure
): AuthReason | null {
  return SIGN_IN_REDIRECT_FAILURE_REASON[failure];
}

const SIGN_IN_REDIRECT_FAILURE_REASON: Record<
  DesktopBrowserSignInFailure,
  AuthReason | null
> = {
  start_failed: AuthReason.SignInStartFailed,
  open_failed: AuthReason.BrowserOpenFailed,
  redirect_timeout: AuthReason.RedirectTimeout,
  state_mismatch: AuthReason.CallbackInvalid,
  unavailable: null,
  already_in_progress: null,
  expired: null,
  cancelled: null,
  declined: null,
  exchange_failed: null,
};
