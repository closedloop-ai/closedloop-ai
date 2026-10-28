/**
 * @file agent-session-sync-rejection-dispatch.ts
 * @description The reason dispatch for a REJECTED session-sync ack: which fold
 * a server rejection is routed to, and what it may spend.
 *
 * Hoisted out of `handleBatchAck` in `agent-session-sync-service.ts` (a
 * shrink-only grandfathered hotspot — root AGENTS.md), following the precedent
 * that file already set with `agent-session-sync-ack-fold.ts`,
 * `agent-session-sync-transport-error-fold.ts` and
 * `agent-session-sync-validation-failure.ts`; the collaborators are injected
 * rather than reached for through `this`.
 *
 * ISS-8605 / ISS-8595 made this the file where PRD-699 Appendix A's approved
 * classification actually lands. Exactly TWO reasons still spend a per-row
 * budget here — `validation_failed` (the route's verdict on these bytes) and the
 * CLIENT-side `transport_timeout` (ambiguous, and refundable). Every other
 * reason, INCLUDING one this build cannot name, defers with budgets intact and
 * is bounded by a wall clock. Adding a branch that charges a row is a
 * classification decision, not a wiring one: it needs the row to be plausibly at
 * fault, which is `main/sync/AGENTS.md` invariant 4's test.
 *
 * The branch ORDER is load-bearing and must not be reshuffled into a lookup
 * table: `validation_failed` has to reach `applyValidationFailure` (which
 * decides what the rejection is even attributable to) before any generic fold
 * sees it, and the no-budget-burn classes must be dispatched before the budgeted
 * ones so a deferral can never burn a healthy session's budget.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  type AgentSessionSyncMode,
  SYNC_ACK_DETAIL_MAX_CHARS,
} from "@repo/api/src/types/agent-session";
import type {
  DesktopAgentSessionsAck,
  DesktopAgentSessionsAckReason as DesktopAgentSessionsAckReasonType,
} from "../cloud/cloud-protocol.js";
import {
  DesktopAgentSessionsAckReason,
  UNKNOWN_ACK_REASON,
} from "../cloud/cloud-protocol.js";
import type { LaneEnvironmentalDeferState } from "../sync/lane-environmental-defer.js";
import type { BoundedFailureFoldConfig } from "./agent-session-sync-ack-fold.js";
import { SessionEnvironmentalDeferClass } from "./agent-session-sync-lane-stall-fold.js";
import {
  formatBytes,
  sanitizeUntrustedServerText,
} from "./agent-session-sync-service-helpers.js";
import {
  applyValidationFailure,
  type ValidationFailureDeps,
} from "./agent-session-sync-validation-failure.js";

/**
 * The rejected member of the ack union. Typed here rather than taking the whole
 * union and re-narrowing: an accepted ack has no business reaching this module,
 * and making that a compile error is stronger than a comment saying so.
 */
export type RejectedAgentSessionsAck = Extract<
  DesktopAgentSessionsAck,
  { accepted: false }
>;

export type RejectedAckDispatchInput = {
  ack: RejectedAgentSessionsAck;
  ids: string[];
  syncMode: AgentSessionSyncMode;
  payloadBytes: number;
  /**
   * ISS-5090: whether the sent envelope was one part of a MULTI-part chunk
   * sequence. A `validation_failed` on such a part is not attributable to the
   * persisted row, so it may not spend the deterministic dead-letter budget.
   */
  multiPartEnvelope: boolean;
};

/** The service state and collaborators the dispatch drives. */
export type RejectedAckDispatchDeps = {
  nextRetryAfterMs: Map<string, number>;
  applyBoundedFold: (config: BoundedFailureFoldConfig) => void;
  /** ISS-8710: the shared `validation_failed` collaborator (fold runners). */
  validationFailureDeps: () => ValidationFailureDeps;
  /**
   * ISS-7730: the ENVIRONMENTAL fold. Separate from `applyBoundedFold` because
   * its terminal path is a wall clock, not the counter that fold is built
   * around — see `agent-session-sync-lane-stall-fold.ts`.
   */
  applyLaneStallFold: (input: {
    ids: string[];
    syncMode: AgentSessionSyncMode;
    payloadBytes: number;
    deferClass: SessionEnvironmentalDeferClass;
    /** ISS-10014: the server's `Retry-After`, when it sent a readable one. */
    retryAfterMs?: number;
  }) => Promise<void>;
  transportTimeoutFoldPolicy: () => Omit<
    BoundedFailureFoldConfig,
    "ids" | "syncMode" | "payloadBytes"
  >;
  /**
   * ISS-8610: the LANE-WIDE environmental fold — `unauthenticated`,
   * `target_not_owned`, `transport_unavailable`. Defers every id with its
   * budgets intact on the lane's staged clock and returns the state so the call
   * site can report the wait it is actually taking. ISS-10014: the server's
   * `Retry-After`, when it sent one, is the gate's minimum wait.
   *
   * PLN-2028 (ISS-9963): `reason` is the CAUSE persisted beside a give-up this
   * run reaches, so a relaunch inside the same outage announces what the lane
   * kept failing on rather than reporting an instant and no cause.
   */
  deferLaneEnvironmental: (
    ids: readonly string[],
    reason: SyncReason,
    retryAfterMs?: number
  ) => LaneEnvironmentalDeferState;
  /**
   * ISS-7730: end any lane-wide stall run for these ids. Called only from the
   * ROW-ATTRIBUTABLE branches — a verdict about the row is proof the lane is
   * reachable, so the stall is over. Deliberately NOT called from the
   * environmental classes (`unauthenticated` 401, `rate_limited` 429,
   * `ack_timeout` 408, `transport_unavailable`, an unrecognized reason): those
   * prove nothing about the server's health. ISS-8605 moved 408 into that set —
   * the route never emits one, so a 408 is an intermediary's verdict about the
   * request, not the server's verdict about the row.
   */
  noteLaneAnswered: (ids: string[]) => void;
  noteTransportLoss: (cause: string) => void;
  /** Stop the poll loop until readiness is regained (`feature_disabled`). */
  pauseForFeatureDisabled: () => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
};

/**
 * Route one rejected ack to its fold, applying every effect through `deps`.
 *
 * ISS-8605: the returned promise settles once the ENVIRONMENTAL classes' durable
 * stall clock has been confirmed — the ack path awaits it, because that column
 * is the only bound those classes have and a write nobody waited for is a bound
 * nobody has. Every in-memory effect is still applied synchronously.
 */
export async function dispatchRejectedAck(
  input: RejectedAckDispatchInput,
  deps: RejectedAckDispatchDeps
): Promise<void> {
  const { ack, ids, syncMode, payloadBytes, multiPartEnvelope } = input;
  if (ack.reason === DesktopAgentSessionsAckReason.ValidationFailed) {
    // ISS-7730: a 400 is a verdict ABOUT THE ROW, so the lane is demonstrably
    // reachable and any stall run these ids were accruing ends here.
    deps.noteLaneAnswered(ids);
    // ISS-5090: which budget this rejection may spend depends on what was
    // actually rejected — a multi-id envelope, one part of a multi-part chunk
    // sequence, or a whole session. See
    // `agent-session-sync-validation-failure.ts`.
    applyValidationFailure(
      {
        syncMode,
        ids,
        payloadBytes,
        multiPartEnvelope,
        ...(ack.detail ? { detail: ack.detail } : {}),
      },
      // ISS-8710: one builder, shared with the tail drain's local refusal, so
      // the two producers of this verdict cannot drift onto different budgets.
      deps.validationFailureDeps()
    );
    return;
  }
  if (ack.reason === DesktopAgentSessionsAckReason.FeatureDisabled) {
    deps.pauseForFeatureDisabled();
    deps.logInfo(
      "pausing agent-session sync until readiness is regained because the server rejected agent-session batches with feature_disabled"
    );
    return;
  }
  if (ack.reason === DesktopAgentSessionsAckReason.Unauthenticated) {
    // FEA-3425: auth loss from the HTTP transport. Defer WITHOUT touching any
    // failure counter (the same no-budget-burn class as the FEA-3792
    // `transport_unavailable` no-target defer below): the batch stays queued,
    // every budget stays intact, and the lane resumes when the desktop session
    // refreshes. Since Phase 4a there is no socket write path to fall back to.
    //
    // ISS-8610: and it is now CLOCKED. A 401 is a lane-wide fact — every row
    // would draw it — so it goes on the lane gate, which stages the wait and
    // terminates the run on the durable 24h ceiling.
    //
    // The ladder's floor is 5 minutes where this class used to wait a flat 30s,
    // which would be a RECOVERY REGRESSION on its own: the ordinary way a 401
    // clears is a same-account access-token renewal, and a lane bounced by the
    // gate never asks for a token, so nothing it does can shorten its own wait.
    // `AgentSessionSyncService.noteCredentialsRefreshed` is what actually closes
    // that — a renewal ends the pacing window from the auth seam. The sign-in /
    // org-policy door (`noteLaneRecoverySignal`) is the separate, rarer one, and
    // is NOT the safety net for this case.
    const deferred = deps.deferLaneEnvironmental(
      ids,
      SyncReason.Unauthenticated,
      ack.retryAfterMs
    );
    deps.logInfo(
      `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) rejected as unauthenticated; ` +
        `${describeLaneDefer(ids.length, deferred)} until the desktop session refreshes`
    );
    return;
  }
  if (ack.reason === DesktopAgentSessionsAckReason.TargetNotOwned) {
    // FEA-3425: the server's ownership check refused the sent computeTargetId.
    // Waiting cannot fix a wrong id, and dead-lettering would strand good
    // sessions — defer with budgets intact and surface loudly; identity
    // re-resolves via the normal hello/refresh path.
    //
    // ISS-8610: on the same lane gate as the 401 above, and for the same reason
    // — a 403 on the sent target is a fact about the lane, not about a row.
    const deferred = deps.deferLaneEnvironmental(
      ids,
      SyncReason.TargetNotOwned,
      ack.retryAfterMs
    );
    deps.logWarn(
      `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) rejected: computeTargetId not owned by the authenticated identity; ` +
        `${describeLaneDefer(ids.length, deferred)} awaiting identity re-resolution`
    );
    return;
  }
  await dispatchTransientRejection(input, ack.reason, deps);
}

/**
 * The transient half of the dispatch: the four reasons that either spend a
 * bounded budget or defer, split out so neither function carries the whole
 * chain's cognitive complexity. Reached only after the terminal and
 * no-budget-burn classes above have declined the ack.
 */
async function dispatchTransientRejection(
  input: RejectedAckDispatchInput,
  reason: TransientRejectionReason,
  deps: RejectedAckDispatchDeps
): Promise<void> {
  const { ids, syncMode, payloadBytes } = input;
  if (reason === DesktopAgentSessionsAckReason.AckTimeout) {
    // ISS-8605 (PRD-699 F2): 408 is ENVIRONMENTAL. The sync route was verified
    // never to emit one — a slow upsert surfaces as a 5xx → `ingestion_failed` —
    // so every 408 this lane can receive was injected by a proxy or CDN that
    // never read the payload. Nothing in it is reproducible from the persisted
    // row, so `main/sync/AGENTS.md` invariant 4 forbids it burning the per-row
    // budget it used to spend (3 consecutive → dead-letter). It defers with
    // every budget intact and is bounded instead by the durable 24h wall clock.
    //
    // The `noteLaneAnswered` this branch used to call went with the budget: an
    // intermediary's 408 is not the SERVER answering about the row, so it is no
    // proof the lane is reachable and must not end a stall run.
    await deps.applyLaneStallFold({
      ids,
      syncMode,
      payloadBytes,
      deferClass: SessionEnvironmentalDeferClass.AckTimeout,
      retryAfterMs: input.ack.retryAfterMs,
    });
    return;
  }
  if (reason === DesktopAgentSessionsAckReason.TransportTimeout) {
    // ISS-5088: the local request deadline fired with no server answer — an
    // ambiguous failure the `TransportTimeoutBudget` resolves by suppressing
    // the charge inside a known outage and refunding earlier ones, while still
    // bounding a genuinely undeliverable row.
    deps.applyBoundedFold({
      ids,
      syncMode,
      payloadBytes,
      ...deps.transportTimeoutFoldPolicy(),
    });
    return;
  }
  if (reason === DesktopAgentSessionsAckReason.RateLimited) {
    // FEA-3792 (PRD-536 D9): `RateLimited` is UNAMBIGUOUSLY a genuine
    // server-side throttle — the HTTP wiring returns `TransportUnavailable` when
    // the compute target is not yet known (offline, or the socket hello is
    // pending), handled in its own branch below.
    //
    // ISS-8605 (PRD-699 F1): and it is ENVIRONMENTAL. The route's limiter is
    // keyed on `direct|relay:<org>:<user>:<computeTarget>`
    // (`apps/api/lib/desktop-agent-sessions-handler.ts` → `buildRateLimitKey`),
    // so a 429 can never single out a session — every row on that target would
    // draw the identical answer. Charging it to a row (which used to
    // dead-letter one after 5 consecutive) marks a healthy session bad for
    // someone else's traffic. It now defers with budgets intact on the same 30s
    // window and terminates only on the durable 24h wall clock.
    await deps.applyLaneStallFold({
      ids,
      syncMode,
      payloadBytes,
      deferClass: SessionEnvironmentalDeferClass.RateLimited,
      retryAfterMs: input.ack.retryAfterMs,
    });
    return;
  }
  if (reason === DesktopAgentSessionsAckReason.TransportUnavailable) {
    // FEA-3792 (PRD-536 D9): local transport unavailability (no compute target
    // yet — offline, or the socket hello landed after the batch was prepared).
    // A missing target is not a session-payload problem, so defer with backoff
    // but NEVER increment the dead-letter counter — the FEA-1461 regression
    // this split makes structural instead of racy.
    //
    // ISS-5088: reaching here is unambiguous proof the cloud connection is down
    // (no live compute target). Any `transport_timeout` charge taken before
    // this ack was therefore taken during a lane-wide outage window — hand it
    // back before it can dead-letter a healthy session.
    //
    // ISS-8610: it used to reach the BOUNDED fold with `countsToward: false` and
    // `maxConsecutive: Number.POSITIVE_INFINITY` — invariant 4 satisfied and
    // invariant 5 violated in the same line, since that fold's only terminal
    // path is the counter it was just told not to advance. It is now on the lane
    // gate, which gives it the staged pacing and the durable terminal it never
    // had, still without charging a row.
    deps.noteTransportLoss("cloud transport unavailable");
    const deferred = deps.deferLaneEnvironmental(
      ids,
      SyncReason.TransportUnavailable,
      input.ack.retryAfterMs
    );
    deps.logInfo(
      `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) transport_unavailable (no compute target); ` +
        `${describeLaneDefer(ids.length, deferred)} until a compute target resolves`
    );
    return;
  }
  if (reason === DesktopAgentSessionsAckReason.IngestionFailed) {
    // ISS-7730: LANE-WIDE, not row-attributable. `ingestion_failed` is the
    // route's UNCLASSIFIED 500 fallthrough — every taxonomized reason
    // (Forbidden / ValidationFailed / FeatureDisabled / RateLimited) has already
    // declined by the time it is returned — and the client collapses 502, 504, a
    // deploy-skew 404 and a non-contract 2xx into it too. Nothing in it is
    // reproducible from the persisted row, so `main/sync/AGENTS.md` invariant 4
    // forbids it burning the per-row budget, and the sibling invocation lane
    // classifies the identical server reason the same way. It defers with every
    // budget intact and is bounded instead by the durable wall clock in
    // `agent-session-sync-lane-stall-fold.ts` — the replacement bound invariant 5
    // requires, without which this exemption would be the invariant-5 violation
    // that looks like invariant-4 compliance.
    await deps.applyLaneStallFold({
      ids,
      syncMode,
      payloadBytes,
      deferClass: SessionEnvironmentalDeferClass.IngestionFailed,
      retryAfterMs: input.ack.retryAfterMs,
    });
    return;
  }
  if (reason === UNKNOWN_ACK_REASON) {
    // ISS-8595: the version-skew class, and a TYPED one. The transport resolves
    // a code neither contract in this build can name to this fixed spelling
    // (`desktop-agent-sessions-client.ts`), which is what makes this branch
    // reachable by a real production input rather than only by a test's cast —
    // a fallback nothing can reach changes no skew behavior at all.
    await deferUnrecognizedReason(input, deps, input.ack.unrecognizedReason);
    return;
  }
  // COMPILE TIME: every KNOWN member of the ack union must have been handled
  // above. Adding one to `DesktopAgentSessionsAckReason` fails `tsc` right here
  // until it is deliberately classified — the guarantee this assignment has
  // always carried, and the reason it survives the runtime fallback below.
  const unmappedKnownReason: never = reason;
  /* RUNTIME: the second line, and narrower than the branch above. The typed
     `unknown_ack_reason` case is what a version-skewed cloud actually produces,
     because `desktop-agent-sessions-client.ts` now RESOLVES a code neither
     contract can name into it. This assignment catches an ack that reached the
     service without passing that boundary — an injected `sendBatch`, a future
     socket/relay producer — where the repo's cross-repo rule applies (types do
     not constrain version-skewed input). Worth keeping for what the old code did
     on arrival: it logged at debug and returned, leaving the batch queued with NO
     retry deadline, so the 5s tick re-sent it immediately and forever — a skew
     amplifier against a server already saying no. It fails safe instead of hot. */
  await deferUnrecognizedReason(input, deps, String(unmappedKnownReason));
}

/**
 * PRD-699 Appendix A's safe default for a rejection this build cannot classify:
 * "a status this build has never seen is treated as environmental". Defer with
 * every budget intact, bounded by the same durable 24h wall clock — never a hot
 * retry, never a throw, and never a dead-letter charged to a row whose bytes
 * were never shown to be the problem.
 *
 * `namedReason` is what the PEER called it, when that survived to here: the
 * classification is a fixed spelling, so without this an operator could not tell
 * which new class a newer cloud had started sending. It reaches the log and
 * nothing else — the durable `last_error` is the fixed spelling, so no untrusted
 * text is persisted or dispatched on — and it is sanitized on the way, because
 * it is an untrusted server string headed for the gateway console sink: a raw
 * newline would forge a second log line and a raw ESC would drive the terminal.
 * Same strip + cap `validation_failed`'s `detail` has always had.
 */
function deferUnrecognizedReason(
  input: RejectedAckDispatchInput,
  deps: RejectedAckDispatchDeps,
  namedReason: string | undefined
): Promise<void> {
  const { ids, syncMode, payloadBytes } = input;
  const named = namedReason
    ? ` (${sanitizeUntrustedServerText(namedReason, SYNC_ACK_DETAIL_MAX_CHARS)})`
    : "";
  deps.logWarn(
    `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) rejected with an ack reason this build does not recognize` +
      `${named}; treating it as environmental and deferring ${ids.length} session(s) with budgets intact`
  );
  return deps.applyLaneStallFold({
    ids,
    syncMode,
    payloadBytes,
    deferClass: SessionEnvironmentalDeferClass.UnknownAckReason,
    retryAfterMs: input.ack.retryAfterMs,
  });
}

/**
 * ISS-8610: how a lane-wide environmental defer names itself in the log — the
 * wait the gate actually chose, and whether that wait is now a GIVE-UP.
 *
 * Shared by every call site, the thrown-transport fold included, so they cannot
 * drift into describing the same gate differently, and so a give-up reaches the
 * log on whichever class happened to cross the ceiling. The delay is read back
 * off the state rather than from a constant: the whole point of the gate is
 * that the wait grows with the run.
 */
export function describeLaneDefer(
  sessionCount: number,
  deferred: LaneEnvironmentalDeferState
): string {
  const waitSeconds = Math.round(
    Math.max(0, deferred.nextAttemptAtMs - Date.now()) / 1000
  );
  const stalledSeconds = Math.round(deferred.elapsedMs / 1000);
  const givenUp = deferred.givenUp
    ? " — the lane has GIVEN UP and is stamped durably until a sign-in, an org-policy change or the re-arm window"
    : "";
  return (
    `deferring ${sessionCount} session(s) for ${waitSeconds}s with retry budgets intact ` +
    `(lane stalled ${stalledSeconds}s)${givenUp}`
  );
}

type TransientRejectionReason = Exclude<
  DesktopAgentSessionsAckReasonType | typeof UNKNOWN_ACK_REASON,
  | typeof DesktopAgentSessionsAckReason.FeatureDisabled
  | typeof DesktopAgentSessionsAckReason.TargetNotOwned
  | typeof DesktopAgentSessionsAckReason.Unauthenticated
  | typeof DesktopAgentSessionsAckReason.ValidationFailed
>;
