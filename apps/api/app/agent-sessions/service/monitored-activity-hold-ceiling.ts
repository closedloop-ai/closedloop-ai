/**
 * ISS-11427: the WALL-CLOCK CEILING on a monitored-activity hold.
 *
 * A retry-owned disposition withholds the Session from `acceptedSessionIds`
 * (`persistMonitoredSessionActivity` → `retryRequired` →
 * `upsert-sessions-batch.ts`), which is how the cloud asks the desktop to offer
 * the candidate again. That ask had NO BOUND: the clearing condition is the
 * target materializing, and for a branch ref nobody ever opens a PR for, or a
 * PR the App will never be installed to read, nothing schedules that event.
 *
 * The desktop's side of the same conversation IS bounded. An omitted id burns
 * `MAX_CONSECUTIVE_ACK_OMITTED` (5) deferrals on a 30s window, dead-letters,
 * and may only do so `MAX_ACK_OMITTED_DEAD_LETTERS` (3) times before the class
 * turns NON-RECOVERABLE — with the progressive 5/10/20-minute dead-letter
 * windows in between, roughly 45 minutes of wall clock end to end
 * (`apps/desktop/src/main/agent-sync/agent-session-sync-backoff-policy.ts`;
 * apps/api cannot import it, which is why the numbers are written out here).
 * After that the row is abandoned: the session's LATER updates never sync
 * either, which is the loss this ticket measured — ~48-63 `dead_letter` spans
 * per day, 97.4% of them `ack_omitted`, 100% on the `session_metadata` lane.
 *
 * So the ceiling here is deliberately WELL INSIDE that horizon. The server
 * resolves the hold itself instead of leaving the client to exhaust a budget
 * and drop the row.
 *
 * ## Why this resolution loses nothing
 *
 * Expiry does not discard the evidence — it makes the candidate TERMINAL, which
 * routes it into `retainMonitoredActivityEvidence` exactly
 * as ISS-9181's acknowledged dispositions already are. That is the shape the
 * operator ruled for (PLN-2061 "Governing rulings", 2026-09-18: evidence must
 * land, acknowledge-and-discard is rejected), and it is REVERSIBLE:
 * `retractRetainedMonitoredActivity` removes the retained row the moment a
 * later delivery's own atom contradicts it, so a target that materializes after
 * the ceiling still links on the next delivery. What changes is only that the
 * desktop is no longer FORCED to re-offer the session to get there.
 *
 * Expiry sticks to the TARGET across deliveries: until that retraction, a later
 * delivery settles any held candidate on the same target without holding it
 * ({@link resolveMonitoredActivityHoldExpiry}), new mentions included.
 *
 * ## What the ceiling is measured FROM
 *
 * `SessionDetail.monitoredActivityHeldSince` — the instant the CLOUD's own hold
 * on this session began, written by `recordMonitoredActivityHoldStart` on the
 * first delivery that withheld the acknowledgement and cleared the moment a
 * delivery no longer needs a retry. A multi-part split is ONE delivery
 * (ISS-12031): it releases only on its last part, and only when no part of it
 * retained — see {@link recordMonitoredActivityHoldStart}. The hold can only
 * expire once the ceiling
 * has passed since BOTH that instant AND the activity's own `occurredAt`.
 *
 * It is NOT the session row's `createdAt`, and #8064's review (whitlockk,
 * tamsinb, and the Codex P1) is why. `createdAt` is old for every session that
 * is not brand new, so an old session's FIRST monitored candidate — and every
 * catch-up event from a desktop that has been offline for two hours — cleared
 * the floor on the delivery that first held it. That is zero retries rather
 * than thirty minutes of them, and the warn below fired on ordinary catch-up
 * while claiming a materialization fault. Measuring from the hold itself means
 * the clock starts when the cloud starts holding, whatever the session's age
 * and whatever the delivery's lateness.
 *
 * The event's age alone is wrong in the same direction: nothing bounds how late
 * a delivery may be, and `field-regression-guards` treats a late-arriving older
 * batch as ordinary. `monitoredActivityHeldSince` alone is wrong too — it says
 * nothing about the activity, so a hold opened by one candidate would expire a
 * genuinely fresh sibling the instant it arrived.
 *
 * Both are timestamps rather than an attempt counter because this path is
 * stateless per request and because the max is MONOTONE while the hold stands:
 * a candidate can never un-expire without the hold first being RELEASED, and a
 * released hold is one the desktop no longer has to retry.
 *
 * A FORWARD-SKEWED `occurredAt` — one ahead of the delivery instant — never
 * expires on its OWN age. It carries no usable activity age, and a desktop whose
 * clock runs a few seconds fast produces one for every event it has just
 * recorded; settling that as elapsed would abandon a brand-new candidate on the
 * first delivery of any session already under hold, which is precisely the loss
 * this ceiling exists to close. Once the HOLD itself has stood past the ceiling
 * it is swept rather than settled, so a later delivery gives it a fresh hold
 * (the hold-age bound, #8737 operator ruling 2026-10-12), and it expires on its
 * own once `receivedAt` has caught up with the stamp. The trust partition does
 * not cover this: candidates reaching here are already TRUSTED, and
 * `isWithinTrustedFutureBoundary` trusts anything up to
 * `MAX_TRUSTED_FUTURE_SKEW_MS` (24 hours) ahead.
 *
 * A `null` `monitoredActivityHeldSince` means NOT HELD — the create arm, a
 * session no delivery has ever held, or one whose hold the last delivery
 * released. Nothing has been held, so nothing expires.
 *
 * ## What this does NOT touch
 *
 * The ISS-8131 `SequenceAssembling` hold in `session-slice-gating.ts` has its
 * own ceiling, `sequence-assembling-hold-ceiling.ts`, which shares this
 * constant. Accepting that payload additively while the sequence is still
 * staged would "seal a union of two derivations as one authoritative
 * dataRevision", so that ceiling frees the staged marker first. It was not the
 * measured loss: `session_withheld_from_ack` over the 14 days to 2026-09-28
 * counted `monitored_activity_retry_required` 11,938, `budget_deferred` 150,
 * `slice_threw` 22, `foreign_chunk` 18, and `sequence_assembling`,
 * `revision_pending` and `revision_too_new` ZERO.
 */

import { monitoredActivityTargetKey } from "@repo/api/src/types/monitored-activity-target";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import {
  type MonitoredActivityCandidate,
  monitoredActivityCandidateIdentity,
} from "./monitored-session-activity-shared";
import type { AgentSessionUpsertTx } from "./records";

/**
 * How long the cloud may hold a Session's acknowledgement for one
 * monitored-activity candidate, measured from the later of the hold's own start
 * and the activity's `occurredAt`.
 *
 * 30 minutes: comfortably inside the desktop's ~45-minute `ack_omitted`
 * exhaustion horizon (see the module header, which carries the derivation), and
 * far longer than the webhook-ingest window the hold exists to wait for — a PR
 * or branch the cloud is going to learn about normally arrives within seconds.
 */
export const MONITORED_ACTIVITY_HOLD_CEILING_MS = 30 * 60 * 1000;

/**
 * The one message the abandonment reports under. A monitor keys on the literal,
 * so it must not be reworded casually.
 */
const HOLD_EXPIRED_LOG_MESSAGE =
  "Monitored session activity hold reached its ceiling";

/**
 * The identities of every HELD candidate whose hold has run past the ceiling,
 * computed ONCE per delivery.
 *
 * `heldCandidates` is the set this delivery would otherwise keep withholding
 * the acknowledgement for — unresolved AND retry-owned. #8064 review (whitlockk,
 * tamsinb): passing every candidate on the delivery put resolved and already
 * terminal refs in scope of the whole-session escalation below, so one stale
 * ref whose atom landed hours ago expired a fresh retry-owned sibling. The
 * desktop re-sends the whole carrier snapshot on every delivery, so on a
 * long-lived session that fired on essentially every sync and the hold never
 * existed at all. The per-candidate answer never changed for those refs —
 * `effectiveMonitoredTargetDisposition` substitutes only over a retry-owned
 * disposition — which is exactly why only the escalation trigger showed it.
 *
 * One pass rather than a predicate both partition gates call per candidate, for
 * two reasons that point the same way. It is the stronger invariant — the two
 * gates read the SAME set rather than re-deriving the same answer, and a
 * candidate they disagreed about would fail
 * `assertEveryMonitoredCandidateAccounted`. And it is the cheaper one: a wide
 * session carries tens of thousands of candidates through both gates, and
 * `Date.parse` on a wire timestamp is the slow path — measured, re-deriving per
 * gate roughly tripled the ISS-9860 bind-budget cases.
 */
export function collectExpiredMonitoredActivityHolds(
  heldCandidates: readonly MonitoredActivityCandidate[],
  receivedAt: Date,
  monitoredActivityHeldSince: Date | null
): MonitoredActivityHoldExpiry {
  const ownAge = new Set<string>();
  let tripped = false;
  const ceilingMs = resolveHoldCeilingCutoffMs(
    receivedAt,
    monitoredActivityHeldSince
  );
  for (const candidate of heldCandidates) {
    const verdict = monitoredActivityHoldVerdictAt(
      candidate,
      ceilingMs,
      receivedAt.getTime()
    );
    if (verdict === HoldVerdict.OwnAge) {
      ownAge.add(monitoredActivityCandidateIdentity(candidate));
    }
    tripped ||= verdict !== HoldVerdict.Held;
  }
  if (!tripped) {
    return { expired: ownAge, ownAge };
  }
  // ONE held candidate past the ceiling expires the SESSION's whole hold,
  // because `retryRequired` is one boolean for the session: a single fresher
  // retry-owned sibling keeps the id out of `acceptedSessionIds` just as
  // effectively as all of them. A LIVE session on a repository the organization
  // will never install the App on emits a new unresolvable mention every few
  // minutes, so per-candidate expiry alone never empties the held set and the
  // desktop abandons the session anyway — the same loss, reached by a slower
  // road.
  //
  // The fresher sibling loses nothing by it: its evidence is RETAINED rather
  // than discarded, and `retractRetainedMonitoredActivity` removes that row on
  // the first later delivery that can land its atom. What it loses is the
  // remainder of its own thirty minutes, and only on a session that has already
  // proved it holds targets nothing materializes. A swept-in candidate is not in
  // `ownAge`, so a later delivery gives it a fresh hold of its own (#8737,
  // operator ruling 2026-10-12: "Give B its own hold").
  return {
    expired: new Set(heldCandidates.map(monitoredActivityCandidateIdentity)),
    ownAge,
  };
}

/**
 * `expired`: every held candidate the ceiling resolves on this delivery.
 * `ownAge`: the subset whose OWN hold ran past the ceiling; the rest were swept
 * in by the whole-session escalation.
 */
export type MonitoredActivityHoldExpiry = {
  expired: ReadonlySet<string>;
  ownAge: ReadonlySet<string>;
};

/**
 * The same question against a PRE-COMPUTED cutoff, so a sweep over many
 * candidates subtracts the ceiling once instead of per candidate. Answers for
 * ONE candidate: `OwnAge` when its own hold ran out, `HoldAge` when it trips the
 * ceiling only because the hold itself has, and `Held` otherwise.
 *
 * HOLD-AGE BOUND (#8737, operator ruling 2026-10-12: "Give B its own hold"). A
 * stamp that cannot measure its own age no longer waits on a sibling to trip
 * the ceiling, because a settled sibling is no longer held. Once the HOLD has
 * stood past the ceiling (`ceilingMs` is non-null only then):
 * - an unparseable `occurredAt` will never gain an age, so it expires as its
 *   own (`OwnAge`) and settles its target;
 * - a forward-skewed one trips the ceiling but is swept (`HoldAge`), so a later
 *   delivery gives it a fresh hold, and it settles on its own once the
 *   delivery clock overtakes the stamp. A desktop only seconds fast therefore
 *   loses at most the rest of one hold, never its evidence or its retry.
 */
function monitoredActivityHoldVerdictAt(
  candidate: MonitoredActivityCandidate,
  ceilingMs: number | null,
  deliveredAtMs: number
): HoldVerdict {
  if (ceilingMs === null) {
    return HoldVerdict.Held;
  }
  const occurredAtMs = Date.parse(candidate.event.occurredAt);
  if (!Number.isFinite(occurredAtMs)) {
    return HoldVerdict.OwnAge;
  }
  if (occurredAtMs > deliveredAtMs) {
    return HoldVerdict.HoldAge;
  }
  return occurredAtMs < ceilingMs ? HoldVerdict.OwnAge : HoldVerdict.Held;
}

/**
 * The instant an `occurredAt` must predate for its hold to have expired, or
 * `null` when no hold can have elapsed at all.
 *
 * `null` when the session is NOT HELD (`monitoredActivityHeldSince` absent) and
 * when the cloud has held it for less than the ceiling — both say the same
 * thing, that the hold has not run long enough to give up on, whatever the
 * event's own age. An unparseable stored timestamp is treated the same way: the
 * conservative answer is to keep holding.
 */
function resolveHoldCeilingCutoffMs(
  receivedAt: Date,
  monitoredActivityHeldSince: Date | null
): number | null {
  if (monitoredActivityHeldSince === null) {
    return null;
  }
  const heldSinceMs = monitoredActivityHeldSince.getTime();
  if (!Number.isFinite(heldSinceMs)) {
    return null;
  }
  const cutoffMs = receivedAt.getTime() - MONITORED_ACTIVITY_HOLD_CEILING_MS;
  return heldSinceMs < cutoffMs ? cutoffMs : null;
}

/**
 * Move `SessionDetail.monitoredActivityHeldSince` to whatever THIS delivery
 * proved: the delivery instant when a hold has just opened, `null` when the
 * hold is over, and nothing while a standing hold continues.
 *
 * ISS-12031: a multi-part split is judged as ONE delivery, because a part's own
 * verdict says nothing about its siblings. A split ships its non-monitored
 * parts with every carrier stripped and may page its candidates (newest first,
 * across targets) over several parts, so an early part can be all resolved
 * while a later one holds the stuck target. Releasing on that early part and
 * re-opening on the later one restarted the ceiling on every ack-omit retry,
 * which replays from part 0. So `monitoredActivityHoldPartRetained` records
 * whether any part of the CURRENT split has retained (reset on part 0, OR-ed
 * after), any part that retains opens the hold, and only the LAST part may
 * release it — and only when no part retained. An unsplit delivery is its own
 * last part and releases exactly as before.
 *
 * Written only on transitions, never on the steady state, so an ordinary sync
 * of a held or unheld session pays no extra statement inside the sync
 * transaction. A hold that is released and later re-opened starts a fresh
 * thirty minutes, which is the point: the desktop's own `ack_omitted` budget
 * resets on an accepted id too. A target the ceiling already settled does not
 * re-open one ({@link resolveMonitoredActivityHoldExpiry}).
 */
export async function recordMonitoredActivityHoldStart(
  tx: AgentSessionUpsertTx,
  input: Readonly<{
    sessionArtifactId: string;
    storedHeldSince: Date | null;
    /** Whether an earlier part of the current split retained the hold. */
    storedPartRetained: boolean | null;
    holdRetained: boolean;
    /** The delivery's `chunk`; absent or one part means unsplit. */
    chunk: Readonly<{ index: number; total: number }> | null | undefined;
    receivedAt: Date;
  }>
): Promise<void> {
  const next = resolveMonitoredActivityHold(input);
  const data: {
    monitoredActivityHeldSince?: Date | null;
    monitoredActivityHoldPartRetained?: boolean;
  } = {};
  if (next.heldSince !== input.storedHeldSince) {
    data.monitoredActivityHeldSince = next.heldSince;
  }
  if (
    next.partRetained !== null &&
    next.partRetained !== (input.storedPartRetained ?? false)
  ) {
    data.monitoredActivityHoldPartRetained = next.partRetained;
  }
  if (Object.keys(data).length === 0) {
    return;
  }
  await tx.sessionDetail.update({
    where: { artifactId: input.sessionArtifactId },
    data,
    // The primary key alone, so the discarded result is one column rather than
    // `RETURNING *` over every scalar on the row. `update` rather than
    // `updateMany` because a missing row here is not acceptable — the ingest
    // slice created or found it moments ago in this same transaction, so the
    // `P2025` throw is the signal.
    select: { artifactId: true },
  });
}

/**
 * The hold start and split marker this delivery leaves behind. `partRetained`
 * is `null` for an unsplit delivery, which never touches the marker.
 */
function resolveMonitoredActivityHold(input: {
  storedHeldSince: Date | null;
  storedPartRetained: boolean | null;
  holdRetained: boolean;
  chunk: Readonly<{ index: number; total: number }> | null | undefined;
  receivedAt: Date;
}): { heldSince: Date | null; partRetained: boolean | null } {
  const openedOrStanding = input.storedHeldSince ?? input.receivedAt;
  const chunk = input.chunk;
  if (!chunk || chunk.total <= 1) {
    return {
      heldSince: input.holdRetained ? openedOrStanding : null,
      partRetained: null,
    };
  }
  const earlierPartRetained =
    chunk.index > 0 && (input.storedPartRetained ?? false);
  const partRetained = earlierPartRetained || input.holdRetained;
  if (input.holdRetained) {
    return { heldSince: openedOrStanding, partRetained };
  }
  const lastPart = chunk.index >= chunk.total - 1;
  return {
    heldSince: lastPart && !partRetained ? null : input.storedHeldSince,
    partRetained,
  };
}

/**
 * The per-organization emission budget for the abandonment warn.
 *
 * #8064 review (whitlockk): batch aggregation alone does not bound this — an
 * authenticated client can keep sending positive batches and drive one warn per
 * batch indefinitely, and `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * asks for a per-org/reason budget at the choke point. The reason is fixed here
 * (a hold reached its ceiling), so the organization IS the key. Suppressed
 * batches are not discarded: their count is flushed as an `aggregated` rollup
 * under the same message, so the monitor still sees the volume.
 */
const holdExpiredEmissionThrottle = new FixedWindowEmissionThrottle<{
  organizationId: string;
}>({
  onFlush: (context, occurrences, cause) => {
    emitAbandonedHoldRollup(context.organizationId, occurrences, cause);
  },
});

/**
 * Report, at most once per organization per emission window, that holds were
 * abandoned at the ceiling.
 *
 * WARN because an operator genuinely should look: a non-zero count means the
 * cloud has held a target for the full ceiling SINCE ITS OWN HOLD BEGAN and
 * still cannot materialize it, which is a repository-connection or
 * webhook-ingest problem rather than ordinary sync traffic. Because the cutoff
 * reads `monitoredActivityHeldSince` rather than the session's age, neither an
 * offline catch-up nor a first-connect backfill of old sessions can raise it —
 * those deliveries OPEN the hold, they do not arrive past it.
 *
 * Batch-aggregated before the budget is even consulted, for the reason
 * `apps/api/AGENTS.md` gives: the payload is caller-supplied and
 * deterministically re-sent, so a per-row line is an amplification vector.
 *
 * Silent at zero, so the message measures abandonment rather than every sync.
 */
export function reportAbandonedMonitoredActivityHolds(
  context: Readonly<{ computeTargetId: string; organizationId: string }>,
  holdExpiredCount: number
): void {
  if (holdExpiredCount <= 0) {
    return;
  }
  const decision = holdExpiredEmissionThrottle.record(
    context.organizationId,
    { organizationId: context.organizationId },
    Date.now()
  );
  if (decision.flushedSuppressedCount > 0) {
    emitAbandonedHoldRollup(
      context.organizationId,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  if (!decision.emit) {
    return;
  }
  log.warn(HOLD_EXPIRED_LOG_MESSAGE, {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
    holdExpiredCount,
    holdCeilingMs: MONITORED_ACTIVITY_HOLD_CEILING_MS,
    occurrences: 1,
  });
}

/**
 * The rollup for batches a closed window suppressed: one line carrying how many
 * there were, marked `aggregated` so a monitor can tell it from a first
 * occurrence. It omits `computeTargetId` and `holdExpiredCount`, which the
 * suppressed batches do not share.
 */
function emitAbandonedHoldRollup(
  organizationId: string,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(HOLD_EXPIRED_LOG_MESSAGE, {
    organizationId,
    occurrences,
    aggregated: true,
    flushedBy,
    holdCeilingMs: MONITORED_ACTIVITY_HOLD_CEILING_MS,
  });
}

/** Exposed so tests can reset the budget between cases; production must not. */
export function resetAbandonedMonitoredActivityHoldThrottle(): void {
  holdExpiredEmissionThrottle.clear();
}

/**
 * Every held candidate this delivery settles at the ceiling, and the subset on
 * a TARGET an earlier delivery's ceiling already settled — new mentions of that
 * target included, so the subset is keyed by target, not by candidate.
 *
 * A held candidate on a target in `ceilingSettledTargetKeys`
 * ({@link import("./monitored-session-activity-retention").findCeilingSettledMonitoredTargetKeys})
 * is settled outright and does not take part in the ceiling below, so it can
 * neither re-open a hold nor trip the whole-session escalation that would
 * expire another target's fresh hold. Per target, not per session: a PR whose
 * webhook is a few seconds behind still gets its own retry. The settled subset
 * is returned so it is not reported as a new abandonment on every sync, and the
 * escalation-swept subset so its retained row records that it never ran its own
 * hold, and is not settled by it (#8737, operator ruling 2026-10-12).
 */
export function resolveMonitoredActivityHoldExpiry(
  heldCandidates: readonly MonitoredActivityCandidate[],
  receivedAt: Date,
  monitoredActivityHeldSince: Date | null,
  ceilingSettledTargetKeys: ReadonlySet<string>
): {
  expired: Set<string>;
  ceilingSettled: Set<string>;
  sweptByEscalation: Set<string>;
} {
  const ceilingSettled = new Set<string>();
  const stillHeld: MonitoredActivityCandidate[] = [];
  for (const candidate of heldCandidates) {
    if (
      ceilingSettledTargetKeys.has(monitoredActivityTargetKey(candidate.target))
    ) {
      ceilingSettled.add(monitoredActivityCandidateIdentity(candidate));
    } else {
      stillHeld.push(candidate);
    }
  }
  const ceiling = collectExpiredMonitoredActivityHolds(
    stillHeld,
    receivedAt,
    monitoredActivityHeldSince
  );
  const sweptByEscalation = new Set(
    [...ceiling.expired].filter((identity) => !ceiling.ownAge.has(identity))
  );
  const expired = new Set([...ceiling.expired, ...ceilingSettled]);
  return { expired, ceilingSettled, sweptByEscalation };
}

const HoldVerdict = {
  Held: "held",
  OwnAge: "own_age",
  HoldAge: "hold_age",
} as const;
type HoldVerdict = (typeof HoldVerdict)[keyof typeof HoldVerdict];
