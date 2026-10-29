import { RELAY_PRESENCE_SILENCE_MS } from "./relay-heartbeat";

/**
 * ISS-7486: the bounded metric dimension for a REJECTED desktop command ack.
 *
 * `relay.command_acks` is a Datadog log metric over the `Relay command ack
 * received` line, grouped by `accepted`. That answers "how many were rejected"
 * and nothing else, so a 0.006% accept rate names no culprit. The desktop sends
 * a free-form `reason` string with every rejection, but it arrives as untrusted
 * wire input from a version-skewed client, and tagging a metric with it directly
 * would let one old build mint unbounded tag cardinality.
 *
 * So the wire string is folded to a stable code here and THAT is tagged. The
 * fold is 1:1 over the reasons the desktop can emit today — no lumping, so the
 * breakdown still names the exact reject path — plus the retired strings that
 * older Desktop builds still send, and anything unrecognized lands on `Unknown`
 * rather than reaching Datadog (root AGENTS.md, Cross-Repo Compatibility: map
 * unknown reasons to a generic rather than failing).
 */

/** Stable, low-cardinality codes for a rejected command ack. */
export const DesktopCommandAckRejectionReason = {
  /** `resolveOperationId` found no operation, or a reserved command's operationId and path disagree. */
  UnroutableOperation: "unroutable_operation",
  OnboardingIncomplete: "onboarding_incomplete",
  CommandsPaused: "commands_paused",
  MissingCommandId: "missing_command_id",
  UnsupportedMethod: "unsupported_method",
  PathOutsideGateway: "path_outside_gateway",
  SigningNoKeysAuthorized: "signing_no_keys_authorized",
  SigningUnsignedCommand: "signing_unsigned_command",
  SigningUnknownKey: "signing_unknown_key",
  SigningInvalidSignature: "signing_invalid_signature",
  SigningStaleOrReplayed: "signing_stale_or_replayed",
  SigningPayloadMismatch: "signing_payload_mismatch",
  NudgePayloadInvalid: "nudge_payload_invalid",
  /** The nudge carried no target context at all. Absence, not disagreement. */
  NudgeContextAbsent: "nudge_context_absent",
  /** The Desktop could not resolve an active context for the nudge. */
  NudgeActiveContextUnresolved: "nudge_active_context_unresolved",
  /** Nudge and Desktop each named a compute target and they differ. */
  NudgeComputeTargetMismatch: "nudge_compute_target_mismatch",
  /** The nudge named a gateway and it differs from the active one. */
  NudgeGatewayMismatch: "nudge_gateway_mismatch",
  BrowserKeyApprovalPayloadInvalid: "browser_key_approval_payload_invalid",
  BrowserKeyRevokePayloadInvalid: "browser_key_revoke_payload_invalid",
  /** The Desktop could not resolve an active context for a browser-key command. */
  BrowserKeyActiveContextUnresolved: "browser_key_active_context_unresolved",
  /** Command and Desktop each named a compute target and they differ. */
  BrowserKeyComputeTargetMismatch: "browser_key_compute_target_mismatch",
  /** The command named a gateway and it differs from the active one. */
  BrowserKeyGatewayMismatch: "browser_key_gateway_mismatch",
  BrowserKeyRevokeFailed: "browser_key_revoke_failed",
  /**
   * ISS-7486 retired: a pre-split Desktop build's single nudge context reason,
   * which could mean any of the four `nudge_*` codes above. Traffic here is a
   * rollout reading, not an unexplained reject.
   */
  NudgeContextMismatch: "nudge_context_mismatch",
  /** ISS-7486 retired: the browser-key equivalent of `nudge_context_mismatch`. */
  BrowserKeyContextMismatch: "browser_key_context_mismatch",
  /** The ack said `accepted: false` and carried no reason at all. */
  Unspecified: "unspecified",
  /** A reason string this build does not recognize — almost always version skew. */
  Unknown: "unknown",
} as const;

export type DesktopCommandAckRejectionReason =
  (typeof DesktopCommandAckRejectionReason)[keyof typeof DesktopCommandAckRejectionReason];

/**
 * Wire string -> code for the reasons a CURRENT Desktop build emits. Keys are
 * the literals the desktop producers send; they are duplicated here because
 * `packages/api` cannot import `apps/desktop`, and
 * `apps/desktop/test/command-ack-rejection-reason-parity.test.ts` imports the
 * desktop-side constants and fails if one stops folding to a known code.
 *
 * Built with `Object.create(null)` so a reason of `__proto__` or `constructor`
 * cannot reach an inherited member (root AGENTS.md, dispatch tables).
 */
const CURRENT_WIRE_REASON_TO_CODE: Record<
  string,
  DesktopCommandAckRejectionReason
> = Object.assign(Object.create(null), {
  "operationId/path mismatch":
    DesktopCommandAckRejectionReason.UnroutableOperation,
  "onboarding not completed":
    DesktopCommandAckRejectionReason.OnboardingIncomplete,
  "cloud commands paused by user":
    DesktopCommandAckRejectionReason.CommandsPaused,
  "commandId is required": DesktopCommandAckRejectionReason.MissingCommandId,
  "unsupported method": DesktopCommandAckRejectionReason.UnsupportedMethod,
  "path must start with /api/gateway/":
    DesktopCommandAckRejectionReason.PathOutsideGateway,
  "invalid github resync nudge payload":
    DesktopCommandAckRejectionReason.NudgePayloadInvalid,
  "github resync nudge target context absent":
    DesktopCommandAckRejectionReason.NudgeContextAbsent,
  "github resync nudge active target context unresolved":
    DesktopCommandAckRejectionReason.NudgeActiveContextUnresolved,
  "github resync nudge compute target mismatch":
    DesktopCommandAckRejectionReason.NudgeComputeTargetMismatch,
  "github resync nudge gateway mismatch":
    DesktopCommandAckRejectionReason.NudgeGatewayMismatch,
});

/**
 * Wire string -> code for reasons NO current Desktop build emits any more.
 *
 * ISS-7486 split each of these into the conditions it was collapsing, so a
 * Desktop on this build sends one of the split strings instead. Removing them
 * here would fold an older build's rejection to `unknown` and lose the one
 * reject path that owned 100% of production rejections, so they stay accepted
 * (root AGENTS.md, Compatibility Guardrail: removing a shim needs explicit
 * human approval). They keep codes of their own rather than folding onto a
 * split code, because a pre-split build cannot say which condition it hit and
 * publishing a guess would be a confident wrong answer.
 *
 * ISS-12784 removed browser command signing from the Desktop, so the six
 * `unauthorized: *` signing rejects and the browser command-key rejects are
 * legacy too: installed Desktops keep sending them.
 */
const LEGACY_WIRE_REASON_TO_CODE: Record<
  string,
  DesktopCommandAckRejectionReason
> = Object.assign(Object.create(null), {
  "github resync nudge target context mismatch":
    DesktopCommandAckRejectionReason.NudgeContextMismatch,
  "browser command key target context mismatch":
    DesktopCommandAckRejectionReason.BrowserKeyContextMismatch,
  "unauthorized: no keys authorized":
    DesktopCommandAckRejectionReason.SigningNoKeysAuthorized,
  "unauthorized: unsigned command":
    DesktopCommandAckRejectionReason.SigningUnsignedCommand,
  "unauthorized: unknown signing key":
    DesktopCommandAckRejectionReason.SigningUnknownKey,
  "unauthorized: invalid signature":
    DesktopCommandAckRejectionReason.SigningInvalidSignature,
  "unauthorized: stale or replayed command":
    DesktopCommandAckRejectionReason.SigningStaleOrReplayed,
  "unauthorized: payload_mismatch":
    DesktopCommandAckRejectionReason.SigningPayloadMismatch,
  "invalid browser command key approval request payload":
    DesktopCommandAckRejectionReason.BrowserKeyApprovalPayloadInvalid,
  "invalid browser command key revocation payload":
    DesktopCommandAckRejectionReason.BrowserKeyRevokePayloadInvalid,
  "browser command key active target context unresolved":
    DesktopCommandAckRejectionReason.BrowserKeyActiveContextUnresolved,
  "browser command key compute target mismatch":
    DesktopCommandAckRejectionReason.BrowserKeyComputeTargetMismatch,
  "browser command key gateway mismatch":
    DesktopCommandAckRejectionReason.BrowserKeyGatewayMismatch,
  "browser command key revocation failed":
    DesktopCommandAckRejectionReason.BrowserKeyRevokeFailed,
});

const WIRE_REASON_TO_CODE: Record<string, DesktopCommandAckRejectionReason> =
  Object.assign(
    Object.create(null),
    CURRENT_WIRE_REASON_TO_CODE,
    LEGACY_WIRE_REASON_TO_CODE
  );

/**
 * Folds a rejected ack's wire `reason` to its bounded metric code.
 *
 * Only call this for a rejection. An ACCEPTED ack has no rejection reason, and
 * tagging one `unspecified` would put accepted traffic in a rejection bucket.
 */
export function classifyDesktopCommandAckRejection(
  reason: string | undefined
): DesktopCommandAckRejectionReason {
  if (reason === undefined || reason.trim() === "") {
    return DesktopCommandAckRejectionReason.Unspecified;
  }
  return (
    WIRE_REASON_TO_CODE[reason] ?? DesktopCommandAckRejectionReason.Unknown
  );
}

/** Every wire string this build folds to a known code. Test/parity surface. */
export function knownDesktopCommandAckWireReasons(): string[] {
  return Object.keys(WIRE_REASON_TO_CODE);
}

/**
 * The subset kept only for version skew — no current Desktop producer emits one.
 *
 * The parity guard checks the fold table against the desktop producers for SET
 * EQUALITY, so it needs this list to tell a deliberately retired mapping from a
 * dead one whose producer was renamed out from under it.
 */
export function legacyDesktopCommandAckWireReasons(): string[] {
  return Object.keys(LEGACY_WIRE_REASON_TO_CODE);
}

/**
 * ISS-7223: the closed set of outcomes the ack path can REPORT.
 *
 * `relay.command_acks` grouped by `accepted` can only ever describe acks that
 * ARRIVED, so a command whose ack never came is not a bucket in it — it is the
 * arithmetic residue of `relay.commands.dispatch` minus this metric. Over 24h to
 * 2026-08-19 that residue was 595 of 10,449 (5.7%) with nothing naming it: a
 * user's command silently not landing, which is the "never let the UI lie about
 * state" rule losing to silence rather than to a wrong value.
 *
 * Tagging the line with THIS instead makes the third case a bucket rather than a
 * subtraction. `accepted` stays on the line beside it — it is what a
 * version-skewed reader and every existing monitor already query.
 *
 * THE THREE ARE NOT A PARTITION OF COMMANDS, and must not be summed as one.
 * `timed_out` is an observation made AT the deadline, not a terminal state: the
 * sweep that emits it changes no command state, so a command reported
 * `timed_out` can still be acked afterwards and produce a second, genuinely
 * different event. Such an ack carries `lateAck: true` on its line, and that
 * flag — not a subtraction against a second metric — is the exact overlap term,
 * so `timed_out` minus `lateAck` is the count that never resolved. Making
 * `timed_out` truly terminal would mean retiring or retrying the command, which
 * is a delivery-semantics decision this observability path does not get to make.
 */
export const DesktopCommandAckOutcome = {
  Accepted: "accepted",
  Rejected: "rejected",
  /** No ack had arrived by the deadline. Emitted by the sweep, never by a desktop. */
  TimedOut: "timed_out",
} as const;

export type DesktopCommandAckOutcome =
  (typeof DesktopCommandAckOutcome)[keyof typeof DesktopCommandAckOutcome];

/**
 * The outcome of an ack that actually arrived.
 *
 * `accepted` is the ONE field every desktop build has always sent, so this fold
 * needs nothing a version-skewed client omits: an ack from a build that predates
 * every field added since still lands in a named bucket rather than an unknown
 * one.
 */
export function resolveDesktopCommandAckOutcome(
  accepted: boolean
): DesktopCommandAckOutcome {
  return accepted
    ? DesktopCommandAckOutcome.Accepted
    : DesktopCommandAckOutcome.Rejected;
}

/**
 * Why an ack never arrived, to the extent the cloud can actually tell.
 *
 * The ticket's open question is whether the unacked commands are explained by
 * the 289 concurrent disconnects, and it says correlating them "needs the ack
 * path to carry a reason; today it cannot be split". This is that reason, and it
 * is deliberately three values rather than two: a target whose presence is
 * simply not known must not be folded into either real cause, because doing so
 * would publish a confident split the data does not support.
 */
export const DesktopCommandAckTimeoutCause = {
  /** The target had stopped sending presence — the disconnect-correlated half. */
  TargetSilent: "target_silent",
  /**
   * The target is live and already holds other commands in flight.
   *
   * Such a command is plausibly waiting its turn behind the target's declared
   * in-flight ceiling rather than having lost its ack, so it is held apart from
   * `TargetPresent` on purpose. The rule is deliberately conservative — it does
   * not re-read the ceiling to prove the queue is actually full — because the
   * cost of guessing wrong is opposite on the two sides: over-assigning here
   * understates a defect count that can still be read as a floor, while
   * under-assigning would inflate `TargetPresent` with ordinary queueing and
   * publish a lost-ack rate that is simply not true.
   */
  TargetBusy: "target_busy",
  /** The target was live, idle, and still never acked. The ack itself was lost. */
  TargetPresent: "target_present",
  /** No presence timestamp was readable for the target. Never a guess. */
  TargetUnknown: "target_unknown",
} as const;

export type DesktopCommandAckTimeoutCause =
  (typeof DesktopCommandAckTimeoutCause)[keyof typeof DesktopCommandAckTimeoutCause];

/**
 * Splits a timed-out ack by what the cloud can observe about its target.
 *
 * `silentMs` is `undefined` when no presence timestamp could be read, which is
 * unknown and not zero — a missing read must never be reported as a target that
 * was present. Silence is checked BEFORE in-flight work, because rows left
 * `accepted`/`running` on a target that is gone are stranded, not busy, and
 * reading them as busy would move the disconnect-correlated half of the
 * population — the half this ticket exists to size — into the wrong bucket.
 */
export function classifyDesktopCommandAckTimeout(input: {
  silentMs: number | undefined;
  inFlightOnTarget: number;
}): DesktopCommandAckTimeoutCause {
  if (input.silentMs === undefined || !Number.isFinite(input.silentMs)) {
    return DesktopCommandAckTimeoutCause.TargetUnknown;
  }
  if (input.silentMs >= RELAY_PRESENCE_SILENCE_MS) {
    return DesktopCommandAckTimeoutCause.TargetSilent;
  }
  return input.inFlightOnTarget > 0
    ? DesktopCommandAckTimeoutCause.TargetBusy
    : DesktopCommandAckTimeoutCause.TargetPresent;
}

/**
 * How long a command may sit unacked before its ack is reported lost.
 *
 * Lives beside the outcome rather than with the sweep because it is what
 * `timed_out` MEANS: the sweep emits past this bound and the ack path marks a
 * late ack past the same one, so the overlap term is exact only while both read
 * a single value. Two copies would let a late ack be counted against a deadline
 * the sweep no longer uses.
 *
 * Generous on purpose. A delivered command is acked on receipt, inside the
 * relay's 4s peer timeout and the cloud's 5s fetch timeout, so seconds would be
 * defensible for the delivered case — but nothing persists delivery, so the
 * population also holds commands legitimately waiting on an offline or busy
 * target. Ten minutes is well past every transport bound.
 */
export const DESKTOP_COMMAND_ACK_DEADLINE_MS = 10 * 60 * 1000;
