import {
  normalizeSessionStatus,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import { maxDate } from "./coercion";
import type { SessionTotals } from "./records";

/**
 * FEA-3477 (D4): the SessionDetail time columns that a resync must never move
 * backward. A late-arriving retry of an OLDER batch carries stale timestamps;
 * writing them unconditionally would revert a newer sync's genuine values
 * (e.g. null-out a `sessionEndedAt` a later batch already set). All three are
 * therefore max-wins against the persisted value, mirroring the `lastActivityAt`
 * monotonicity in persist-session-children.ts.
 */
export type RegressionGuardedTimestamps = {
  sessionStartedAt: Date | null;
  sessionUpdatedAt: Date | null;
  sessionEndedAt: Date | null;
};

/**
 * FEA-3477 (D4): the update-arm time patch. Each field is the later of the
 * persisted value and the incoming value; a nullable field stays whichever
 * non-null value is newest, so an older batch that omits `sessionEndedAt` can
 * never clear an end a newer batch already recorded.
 *
 * `sessionStartedAt` and `sessionUpdatedAt` are non-null columns, so the
 * incoming value is always present; the guard only prevents them from moving
 * backward. `sessionEndedAt` is nullable — max-wins additionally preserves a
 * previously set end when the incoming value is null.
 *
 * ISS-4946: `repairImplausibleUpdatedAt` is the ONE exception to max-wins on
 * `sessionUpdatedAt` — see {@link isImplausiblyFutureSessionUpdatedAt}. Max-wins
 * cannot heal a watermark a broken clock pushed years ahead, so a plausible
 * incoming value replaces it outright. Truthy-gated: an omitted option keeps the
 * unconditional max-wins behavior.
 *
 * Pure (no DB) so the monotonicity contract is unit-testable without the sync
 * transaction.
 */
export function resolveGuardedTimestampPatch(
  existing: RegressionGuardedTimestamps,
  incoming: {
    sessionStartedAt: Date;
    sessionUpdatedAt: Date;
    sessionEndedAt: Date | null;
  },
  options?: { repairImplausibleUpdatedAt?: boolean }
): {
  sessionStartedAt: Date;
  sessionUpdatedAt: Date;
  sessionEndedAt: Date | null;
} {
  return {
    // maxDate is null-safe and NaN-safe; the incoming value is always a valid
    // non-null Date for the two required columns, so `?? incoming.*` only
    // covers the impossible all-null/NaN case and preserves the non-null type.
    sessionStartedAt:
      maxDate(existing.sessionStartedAt, incoming.sessionStartedAt) ??
      incoming.sessionStartedAt,
    sessionUpdatedAt: options?.repairImplausibleUpdatedAt
      ? incoming.sessionUpdatedAt
      : (maxDate(existing.sessionUpdatedAt, incoming.sessionUpdatedAt) ??
        incoming.sessionUpdatedAt),
    // Deliberately NOT repaired alongside the watermark: clearing or rewinding
    // an end a prior sync recorded is destructive, and `sessionStartedAt` moving
    // backward would break the FEA-3477 monotonicity contract every other caller
    // relies on. Both stay unconditional max-wins, so the poisoned start/end
    // values are PERMANENT — no corrected value can ever bring them back down,
    // and a repaired row reads `sessionStartedAt > sessionUpdatedAt` for good.
    // Accepted: the repair's job is to unstick the freshness gate, not to rewrite
    // history the broken clock already wrote, and the numeric consumers degrade
    // safely (session-display-sort clamps a negative span to 0, `buildWindow`
    // returns null on an inverted window). What survives is a Started/Ended cell
    // rendering the bad clock's date; correcting that needs an explicit repair
    // path, not a relaxation of the monotonicity guard.
    sessionEndedAt: maxDate(existing.sessionEndedAt, incoming.sessionEndedAt),
  };
}

/**
 * FEA-3477 (D4): terminal-status-wins. A run that reached a terminal status must
 * never regress to a non-terminal one when a late retry of an older batch
 * resyncs a stale value. A terminal-to-terminal transition is still allowed, and
 * the create arm is unaffected — this only guards the update arm where a
 * persisted status already exists. Which statuses are terminal is
 * `TERMINAL_SESSION_STATUSES`, not a list here (thadeusb, #5075: the list this
 * docblock used to carry still named the ISS-5592-retired spellings).
 *
 * Returns the status the artifact update should write given the persisted and
 * incoming values.
 */
export function resolveGuardedStatus(
  existingStatus: string | null | undefined,
  incomingStatus: string
): string {
  if (
    existingStatus != null &&
    // Fold before the terminal check so a recognized alias is judged by what it
    // means rather than its stored bytes.
    TERMINAL_SESSION_STATUSES.has(normalizeSessionStatus(existingStatus)) &&
    !TERMINAL_SESSION_STATUSES.has(normalizeSessionStatus(incomingStatus))
  ) {
    return existingStatus;
  }
  return incomingStatus;
}

/**
 * FEA-3477 (D5): the SessionDetail rollup token columns, written ONLY when the
 * normalized per-model token usage is non-empty. An empty normalized array means
 * the payload carried no replacement token data (non-desktop caller, all-empty
 * model strings dropped by `normalizeTokenUsage`, or a future contract that omits
 * `tokenUsageByModel`). persistSessionChildren already skips the
 * `agentSessionTokenUsage` delete+recreate in that case (omission never clears),
 * so writing zeros to these rollup columns here would desync the rollup from the
 * per-model table. Gating the write mirrors that "omission preserves" rule: on an
 * empty payload we omit the columns entirely, leaving the prior values (and the
 * schema `@default(0)` on create) intact.
 */
export function resolveTokenRollupColumns(
  hasTokenUsage: boolean,
  totals: SessionTotals,
  roundCost: (value: number) => number
):
  | {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      estimatedCost: number;
    }
  | Record<string, never> {
  if (!hasTokenUsage) {
    return {};
  }
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    estimatedCost: roundCost(totals.estimatedCost),
  };
}

/**
 * ISS-4946 (wongk review, PR #4327): the largest amount an incoming
 * `session.updatedAt` may lead server receive time and still be believable.
 *
 * Deliberately generous — a day, not the minutes an auth-skew allowance would
 * use. Ordinary drift (seconds to minutes) must stay believable, because this
 * threshold decides when the stored watermark is treated as garbage rather than
 * as an ordering signal, and a merely-fast clock still orders its own snapshots
 * correctly. Only an implausible clock trips it.
 */
export const MAX_SESSION_UPDATED_AT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * ISS-4946 (wongk review, PR #4327): whether a `sessionUpdatedAt` value leads
 * server receive time by more than {@link MAX_SESSION_UPDATED_AT_FUTURE_SKEW_MS}
 * — i.e. it can only have come from a badly wrong clock.
 *
 * `updatedAt` is Desktop-produced and the ingest schema accepts any parseable
 * date, so such a value can be persisted and, because the column is max-wins
 * (FEA-3477 D4), it then sticks. Every later legitimate sync compares older than
 * it, so the whole regression-guarded column set (token costs, frustration,
 * `endsWithError`, the trace-duration triple, the `pullRequests` blob) stops
 * accepting corrections for that session — permanently.
 *
 * The predicate is deliberately applied to the STORED value, not used to clamp
 * the incoming one. Clamping an implausible incoming value to receive time would
 * map every snapshot from a skewed device onto its arrival time, collapsing that
 * device's own ordering and degrading the guards to last-arrival-wins for
 * exactly the fleet the fix targets. Comparing raw values keeps that ordering
 * intact; see {@link resolveGuardedTimestampPatch}'s `repairImplausibleUpdatedAt`
 * for how a poisoned row is unstuck once the clock is corrected.
 */
function isImplausiblyFutureSessionUpdatedAt(
  // Null-safe like `maxDate`, mirroring `RegressionGuardedTimestamps`'s declared
  // nullability: an absent watermark adjudicates nothing, so it is not
  // implausible — it simply carries no claim about the future.
  value: Date | null,
  receivedAt: Date
): boolean {
  return (
    value !== null &&
    value.getTime() >
      receivedAt.getTime() + MAX_SESSION_UPDATED_AT_FUTURE_SKEW_MS
  );
}

/**
 * ISS-4946 (wongk review, PR #4327): whether this apply may write the session's
 * PR state — the legacy `pullRequests` blob AND the session→PR artifact links,
 * which must be gated together or the row settles into a shape the two lanes
 * disagree about (populated blob, zero links).
 *
 * Stricter than the shared `updatedAt >= sessionUpdatedAt` watermark, because
 * `>=` admits a TIE and PR state has a real tie case. Desktop builds before
 * 3bc26f527 committed the session row and the PR/link phases separately with the
 * SAME `updatedAt` and `dataRevision`, so the sync reader can emit an empty
 * pre-link snapshot and a populated post-link snapshot that compare equal here.
 * Sync is at-least-once and can reorder, so the empty one can land last and wipe
 * the newer PR state. Those builds are installed and will keep emitting the pair.
 *
 * The tie-breaker is "the populated snapshot wins": at an equal watermark only a
 * snapshot that actually carries PR evidence may write.
 *
 * KNOWN TRADE-OFF (accepted, ISS-4946 review): nothing on the wire distinguishes
 * that stale empty snapshot from a legitimate ISS-4768 recalculated-to-empty
 * retraction that also lands at an equal watermark — `dataRevision` matches in
 * both cases. On an ENDED session `updatedAt` is frozen, so a retraction driven
 * by a Desktop parser change arrives at exactly that tie and is now skipped: the
 * stored blob outlives the sync that retracted it until some later batch moves
 * the watermark. Preserving is the chosen loss because the wipe is unrecoverable
 * and the phantom is not.
 *
 * The preserved side is not always the blob. Because the lanes are resolved
 * independently, a tie carrying `prs: [ ... ]` with `prRefs: []` writes the new
 * blob and preserves the OLD `session_pr` links, and
 * `toSessionPullRequestProjection` unions the two — the blob entries seed the
 * projection and every surviving authored link is applied on top. Such a row can
 * render more PRs than the snapshot carries, and `verifiedMergedCount` (which is
 * link-derived, and reaches the Sessions row as `prsMerged`) can still count a PR
 * the producer already dropped. That is the same accepted trade-off, inflating a
 * rendered count rather than leaving a phantom blob entry; whoever reads the
 * monitor below should expect both shapes.
 *
 * That accepted loss is REPORTED rather than absorbed. `preservedOnTie` marks the
 * tie branch specifically — not the ordinary stale-batch skip, which is the
 * intended fix and expected traffic — so the caller can route it to a monitor per
 * AGENTS.md "Handling Bad or Nonsensical Data". Without it, a session that keeps
 * a phantom PR forever is indistinguishable from one that never had a retraction,
 * and the volume of the trade-off is unmeasurable in production. It is reported
 * only when the skip actually suppressed a write (`hasSuppressibleWrite`): a
 * pre-link-extraction snapshot that carries neither shape loses nothing at a tie,
 * and counting it would dominate the signal with ties that cost nothing.
 */
function resolveSessionPullRequestWriteGate(params: {
  /** Persisted watermark; `null` on create (no prior row to regress). */
  existingSessionUpdatedAt: Date | null;
  incomingSessionUpdatedAt: Date;
  /**
   * Whether the snapshot carries evidence FOR THE LANE being resolved — the
   * `prs` blob for the blob lane, `prRefs` for the link lane. Never the union of
   * the two: see `resolveSessionPullRequestEvidence`.
   */
  hasPullRequestEvidence: boolean;
  /**
   * Whether THIS LANE would have written at all had the gate admitted it. Gates
   * only the reported `preservedOnTie`, never `shouldWrite` — a lane with
   * nothing to write is harmless either way, but counting it as an accepted loss
   * is not.
   */
  hasSuppressibleWrite: boolean;
}): { shouldWrite: boolean; preservedOnTie: boolean } {
  const { existingSessionUpdatedAt, incomingSessionUpdatedAt } = params;
  if (existingSessionUpdatedAt === null) {
    return { shouldWrite: true, preservedOnTie: false };
  }
  const incoming = incomingSessionUpdatedAt.getTime();
  const stored = existingSessionUpdatedAt.getTime();
  if (incoming > stored) {
    return { shouldWrite: true, preservedOnTie: false };
  }
  if (incoming < stored) {
    return { shouldWrite: false, preservedOnTie: false };
  }
  return {
    shouldWrite: params.hasPullRequestEvidence,
    preservedOnTie:
      !params.hasPullRequestEvidence && params.hasSuppressibleWrite,
  };
}

/**
 * ISS-4946 (wongk review, PR #4327): every freshness decision this apply makes,
 * resolved together so the callers cannot drift apart.
 *
 * - `shouldUpdateGuardedColumns` — the FEA-3419 / ISS-4586 / ISS-4688 watermark
 *   (`updatedAt >= sessionUpdatedAt`, true on create) that gates token/event
 *   costs, frustration, `endsWithError` and the trace-duration triple. A delayed
 *   retry of an older batch must not win by arrival order.
 * - `shouldUpdatePullRequestsBlob` / `shouldUpdatePullRequestLinks` — the
 *   stricter PR gate, resolved once per lane. Both lanes share the SAME
 *   watermark comparison, so a stale batch skips both and a strictly fresher one
 *   (including a genuine retraction) writes both. They diverge only at an equal
 *   watermark, and only toward preserving: each lane must carry evidence of its
 *   own before it may perform a destructive replacement, because the two
 *   producers can legitimately disagree about membership. See
 *   `resolveSessionPullRequestEvidence` for why the union is the wrong input.
 *
 *   SCOPE, stated plainly: these two are the lanes that REPLACE session-owned PR
 *   state, and they are what this gate covers. `persistSessionBranchArtifactLinks`
 *   and `persistSessionPullRequestDetails` also feed the rendered PR projection
 *   and remain ungated here — the branch lane is additive (no replacing
 *   `deleteMany`) and the PR-detail lane carries its own `desktopOwnsRow`
 *   provenance guard, so neither can wipe session PR state the way these two
 *   could. That is a narrower claim than "these two lanes are the whole of PR
 *   state", which would be false.
 * - `didRepairPoisonedWatermark` — the stored watermark is one no clock could
 *   legitimately produce and this batch's is plausible, so the apply is admitted
 *   regardless of the comparison and replaces the poisoned column. That is also
 *   why the PR gate is handed a `null` prior watermark here: a poisoned value
 *   adjudicates nothing, so PR state must not stay frozen on the row being
 *   unstuck. Callers should route this to a monitor — a value that cannot be
 *   right is never silently coerced.
 * - `didPreservePullRequestsOnTie` — the equal-watermark tie-break skipped an
 *   evidence-free snapshot THAT HAD A WRITE TO LOSE, so a genuine retraction
 *   (indistinguishable on the wire from a stale pre-link snapshot) may have been
 *   dropped. Also a route-to-a-monitor signal: it is the accepted loss documented
 *   on {@link resolveSessionPullRequestWriteGate}, and the only way to measure
 *   how often that trade-off actually costs something — which is why a lane that
 *   was never going to write is excluded rather than counted.
 */
export function resolveSessionFreshnessGates(params: {
  /** Persisted watermark; `null` on create (no prior row to regress). */
  existingSessionUpdatedAt: Date | null;
  incomingSessionUpdatedAt: Date;
  /** Server receive time for this batch. */
  receivedAt: Date;
  /** Whether the snapshot carries a non-empty `prs` blob. */
  hasPullRequestBlobEvidence: boolean;
  /** Whether the snapshot carries a non-empty `prRefs` list. */
  hasPullRequestLinkEvidence: boolean;
  /** Whether the blob lane would write at all — see `hasSuppressibleWrite`. */
  hasPullRequestBlobWrite: boolean;
  /** Whether the link lane would write at all — see `hasSuppressibleWrite`. */
  hasPullRequestLinkWrite: boolean;
}): {
  shouldUpdateGuardedColumns: boolean;
  shouldUpdatePullRequestsBlob: boolean;
  shouldUpdatePullRequestLinks: boolean;
  didRepairPoisonedWatermark: boolean;
  didPreservePullRequestsOnTie: boolean;
} {
  const {
    existingSessionUpdatedAt,
    incomingSessionUpdatedAt,
    receivedAt,
    hasPullRequestBlobEvidence,
    hasPullRequestLinkEvidence,
    hasPullRequestBlobWrite,
    hasPullRequestLinkWrite,
  } = params;
  const didRepairPoisonedWatermark =
    isImplausiblyFutureSessionUpdatedAt(existingSessionUpdatedAt, receivedAt) &&
    !isImplausiblyFutureSessionUpdatedAt(incomingSessionUpdatedAt, receivedAt);
  // A poisoned watermark adjudicates nothing, so both lanes see the same "no
  // prior row" state a create sees and unstick together.
  const priorWatermark = didRepairPoisonedWatermark
    ? null
    : existingSessionUpdatedAt;
  const blobGate = resolveSessionPullRequestWriteGate({
    existingSessionUpdatedAt: priorWatermark,
    incomingSessionUpdatedAt,
    hasPullRequestEvidence: hasPullRequestBlobEvidence,
    hasSuppressibleWrite: hasPullRequestBlobWrite,
  });
  const linkGate = resolveSessionPullRequestWriteGate({
    existingSessionUpdatedAt: priorWatermark,
    incomingSessionUpdatedAt,
    hasPullRequestEvidence: hasPullRequestLinkEvidence,
    hasSuppressibleWrite: hasPullRequestLinkWrite,
  });
  return {
    shouldUpdateGuardedColumns:
      existingSessionUpdatedAt === null ||
      didRepairPoisonedWatermark ||
      incomingSessionUpdatedAt >= existingSessionUpdatedAt,
    shouldUpdatePullRequestsBlob: blobGate.shouldWrite,
    shouldUpdatePullRequestLinks: linkGate.shouldWrite,
    didRepairPoisonedWatermark,
    didPreservePullRequestsOnTie:
      blobGate.preservedOnTie || linkGate.preservedOnTie,
  };
}
