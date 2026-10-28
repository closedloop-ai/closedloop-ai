import type { Priority } from "@repo/api/src/types/common";
import {
  normalizeSessionStatus,
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import { sessionWebSearchCostUsd } from "@repo/cost/session-web-search-cost";
import {
  isWithinTrustedFutureBoundary,
  MAX_TRUSTED_FUTURE_SKEW_MS,
} from "@/lib/trusted-timestamp";
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
 * `TERMINAL_SESSION_STATUSES`, not a list here (tamsinb, #5075: the list this
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

/** Inputs to {@link resolveTokenRollupColumns}. */
export type ResolveTokenRollupColumnsParams = {
  hasTokenUsage: boolean;
  totals: SessionTotals;
  roundCost: (value: number) => number;
  /**
   * ISS-7821: the session's persisted `metadata`, for the WEB-SEARCH LINE ITEM.
   *
   * `estimatedCost` is a whole-session dollar figure, but `totals` sums
   * `tokenUsageByModel` and web search is billed per REQUEST — it never lives in
   * a token row, so no sum of them can contain it. That made this derivation
   * systematically LOW by exactly the line item for every session that used web
   * search. Read from the same persisted field the desktop's `webSearchCostSql`
   * reads, at the same price, so the three agree by construction.
   */
  metadata?: unknown;
  /**
   * ISS-7821: the STORED token rollup, or null on create. Read only to decide
   * whether the cost-only web-search patch may fire — see `hasStoredTokenCost`.
   */
  existingTokenRollup?: StoredTokenRollup | null;
  /**
   * ISS-8515: whether ANY row of the RAW payload carried an `estimatedCostUsd`.
   *
   * Must be derived from the raw wire rows, never from `totals`: the wire field
   * is `.optional()` (not nullable) and the desktop omits the key entirely, but
   * `normalizeTokenUsage` folds `?? 0` and `sumTokenUsage` folds `?? 0` again, so
   * by the time `totals` exists "unpriced" and "priced at exactly zero" are
   * indistinguishable. The predicate is `estimatedCostUsd !== undefined` — the
   * same convention `token-event-persistence.ts` uses. A `> 0` or truthiness
   * reading would persist `null` for a genuinely FREE $0 session, moving check
   * 1's population the opposite way from ruling 2.
   */
  anyRowPriced: boolean;
  /**
   * ISS-8515 ERASE GUARD: whether the stored row already holds a NUMERIC
   * `estimated_cost`. A boolean rather than the Decimal itself, so this module
   * stays free of `@repo/database` types; the caller derives it as
   * `existing?.estimatedCost != null`.
   */
  hasStoredEstimatedCost?: boolean;
};

/**
 * The rollup patch, in four shapes. The fourth — counts with NO `estimatedCost`
 * key — is ISS-8515's erase guard: the counts are refreshed while a stored cost
 * is preserved untouched.
 */
export type TokenRollupColumns =
  | {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      estimatedCost: number | null;
    }
  | {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { estimatedCost: number }
  | Record<string, never>;

/**
 * FEA-3477 (D5): the SessionDetail rollup token columns, written ONLY when the
 * normalized per-model token usage is non-empty. An empty normalized array means
 * the payload carried no replacement token data (non-desktop caller, all-empty
 * model strings dropped by `normalizeTokenUsage`, or a future contract that omits
 * `tokenUsageByModel`). `persistSessionChildren` already skips the
 * `agentSessionTokenUsage` delete+recreate in that case (omission never clears),
 * so writing zeros to these rollup columns here would desync the rollup from the
 * per-model table. Gating the write mirrors that "omission preserves" rule: on an
 * empty payload we omit the columns entirely, leaving the prior values intact.
 *
 * ISS-8515: that last clause used to end "(and the schema `@default(0)` on
 * create)". The default is GONE — both production create arms now name
 * `estimated_cost` explicitly — so an omission on create no longer resolves to a
 * confident $0. It resolves to whatever the caller names, which is the point.
 */
export function resolveTokenRollupColumns(
  params: ResolveTokenRollupColumnsParams
): TokenRollupColumns {
  const {
    hasTokenUsage,
    totals,
    roundCost,
    metadata,
    existingTokenRollup,
    anyRowPriced,
    hasStoredEstimatedCost = false,
  } = params;
  const webSearchCost = sessionWebSearchCostUsd(metadata);
  if (!hasTokenUsage) {
    // ISS-7821 review (whitlockk, codex): a WEB-SEARCH-ONLY session — no token rows
    // at all, a billable request count in metadata — used to leave here, and the
    // create arm's `@default(0)` then reported $0 for a session the desktop
    // prices at the line item. A Desktop build predating the ISS-7813 cost writer
    // sends metadata with no token rollup, so this is the ONLY cost this
    // derivation can produce for those payloads.
    //
    // Emitted as an estimated-cost-only patch, never the token columns, so the
    // "omission preserves" rule still holds: `persistSessionChildren` skips the
    // token delete+recreate on an empty payload, and writing zeros to the rollup
    // columns would desync them from a per-model table that still has rows.
    if (webSearchCost > 0 && !hasStoredTokenCost(existingTokenRollup)) {
      return { estimatedCost: roundCost(webSearchCost) };
    }
    return {};
  }
  const counts = {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
  };
  if (anyRowPriced) {
    return {
      ...counts,
      // Added ONCE and disjoint by construction: web-search cost is never in a
      // `tokenUsageByModel` row, so this cannot double-count what `totals` holds.
      estimatedCost: roundCost(totals.estimatedCost + webSearchCost),
    };
  }
  // ISS-8515: token rows exist but NONE carried a price.
  //
  // The guard is on the STORED cost and fires regardless of `webSearchCost`.
  // Gating it on `webSearchCost === 0` (an earlier draft) left the clobber this
  // ticket exists to stop wide open: `hasStoredTokenCost` guards only the
  // no-token early return above, so a payload with unpriced token rows plus
  // web-search metadata fell through and replaced a stored authoritative total
  // with the line item alone.
  if (hasStoredEstimatedCost) {
    return counts;
  }
  if (webSearchCost > 0) {
    return { ...counts, estimatedCost: roundCost(webSearchCost) };
  }
  // Nothing priced this session and there is nothing stored to preserve. `null`
  // is the honest persisted value for an unknown cost — never a fabricated $0,
  // which `sessionHasNumericCost` (ISS-7813) exists to tell apart.
  return { ...counts, estimatedCost: null };
}

/**
 * ISS-4946 (whitlockk review, PR #4327): the largest amount an incoming
 * `session.updatedAt` may lead server receive time and still be believable.
 *
 * Deliberately generous — a day, not the minutes an auth-skew allowance would
 * use. Ordinary drift (seconds to minutes) must stay believable, because this
 * threshold decides when the stored watermark is treated as garbage rather than
 * as an ordering signal, and a merely-fast clock still orders its own snapshots
 * correctly. Only an implausible clock trips it.
 */
export const MAX_SESSION_UPDATED_AT_FUTURE_SKEW_MS = MAX_TRUSTED_FUTURE_SKEW_MS;

/**
 * ISS-7821: the stored per-session token rollup, as much of it as
 * {@link resolveTokenRollupColumns} needs to know whether a prior slice already
 * priced token usage into `estimatedCost`.
 */
export type StoredTokenRollup = {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
};

/**
 * Whether the stored `estimatedCost` already carries a TOKEN component that a
 * cost-only patch would destroy.
 *
 * The whole reason the web-search patch is gated: `estimatedCost` is one column
 * holding `tokens + web search`, and on a payload with no token rows this fold
 * cannot recompute the token half — `totals` is a sum over an empty list. So
 * overwriting the column with the line item ALONE would silently delete a real,
 * previously-computed token cost, trading one under-report for a larger one.
 *
 * An all-zero rollup is the recorded consequence of a session having no token
 * rows, which is exactly the case where there is nothing to preserve and the
 * line item IS the whole cost. A row with token counts is left alone: its stale
 * figure is wrong by at most the line item, where clobbering it would be wrong
 * by the entire token spend.
 */
function hasStoredTokenCost(rollup?: StoredTokenRollup | null): boolean {
  if (!rollup) {
    return false;
  }
  return (
    rollup.inputTokens > 0n ||
    rollup.outputTokens > 0n ||
    rollup.cacheReadTokens > 0n ||
    rollup.cacheWriteTokens > 0n
  );
}

/**
 * ISS-4946 (whitlockk review, PR #4327): whether a `sessionUpdatedAt` value leads
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
 * ISS-8681: the `sessionEndedAt` counterpart of
 * {@link isImplausiblyFutureSessionUpdatedAt} — a value leading server receive
 * time by more than {@link MAX_TRUSTED_FUTURE_SKEW_MS}.
 *
 * Delegates to `isWithinTrustedFutureBoundary` rather than repeating the
 * comparison its sibling spells out, so this predicate cannot drift from the
 * other write paths that already refuse a future instant on the same boundary,
 * and so a non-finite date is refused rather than compared.
 */
function isImplausiblyFutureSessionEndedAt(
  // Null-safe for the same reason as its sibling: `sessionEndedAt` is nullable
  // and an absent end makes no claim about the future.
  value: Date | null,
  receivedAt: Date
): boolean {
  return value !== null && !isWithinTrustedFutureBoundary(value, receivedAt);
}

/**
 * ISS-4946 (whitlockk review, PR #4327): whether this apply may write the session's
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
  /**
   * ISS-9859: admit this lane at a tie without evidence of its own, because the
   * payload is page 0 of a paginated PR list (`isPaginatedPrListPageZero`).
   * Its whole-set replace is the only retraction the sequence gets, and page 0
   * always ties with the base parts of its own sequence. The legacy race this
   * tie rule guards cannot send that marker. Ties only: a STALE page 0 is still
   * skipped.
   */
  admitsWholeSetReplaceAtTie: boolean;
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
  const admitted =
    params.hasPullRequestEvidence || params.admitsWholeSetReplaceAtTie;
  return {
    shouldWrite: admitted,
    preservedOnTie: !admitted && params.hasSuppressibleWrite,
  };
}

/**
 * ISS-4946 (whitlockk review, PR #4327): every freshness decision this apply makes,
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
 *   remains ungated because it is additive (no replacing `deleteMany`).
 *   `persistSessionPullRequestDetails` may resolve detail facts only when its
 *   own provenance guard allows it, but PR-derived branch association is
 *   caller-coordinated with this gate so a stale replay cannot create link state
 *   the replacement lane refused to own. That is a narrower claim than "these
 *   two lanes are the whole of PR state", which would be false.
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
  /**
   * ISS-9859: the payload is page 0 of a paginated PR list, so both lanes are
   * admitted at a tie — see `admitsWholeSetReplaceAtTie`. Omitted means no,
   * which leaves every other tie decision as ISS-4946 made it.
   */
  isPullRequestListPageZero?: boolean;
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
  const admitsWholeSetReplaceAtTie = params.isPullRequestListPageZero === true;
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
    admitsWholeSetReplaceAtTie,
  });
  const linkGate = resolveSessionPullRequestWriteGate({
    existingSessionUpdatedAt: priorWatermark,
    incomingSessionUpdatedAt,
    hasPullRequestEvidence: hasPullRequestLinkEvidence,
    hasSuppressibleWrite: hasPullRequestLinkWrite,
    admitsWholeSetReplaceAtTie,
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

/**
 * ISS-8552: the `sessionEndedAt` a write may actually PERSIST, given the
 * lifecycle status that same write resolves. Applied AFTER
 * {@link resolveGuardedTimestampPatch}, as the last word on the column.
 *
 * `session_ended_at` means "when this run ended". A row whose status resolves to
 * `active` did not end, so a non-null value there is not merely a stale number —
 * it is a record that contradicts itself, and AGENTS.md ("Handling Bad or
 * Nonsensical Data") holds that such a record is valid-or-absent, never
 * partially-corrupt. The honest write is the absence.
 *
 * WHY A SECOND GUARD RATHER THAN A CONDITION INSIDE MAX-WINS. Max-wins exists to
 * resist REGRESSION — an older batch must not walk a legitimate end backwards,
 * nor null one by omission — and that job is untouched, because this gate can
 * only fire when the resolved status is NON-terminal while every regression
 * max-wins defends against is on a terminal row. Concretely:
 * {@link resolveGuardedStatus} returns the STORED status whenever it is terminal
 * and the incoming one is not, so a stored-terminal row always resolves terminal
 * and always keeps its max-wins end. The two guards partition the cases rather
 * than competing for them, which is also why {@link shouldReopenSession} is
 * unaffected: it fires only on a stored-terminal row, so the end it reads is
 * never one this gate could have cleared.
 *
 * WHAT IT REPAIRS, and why no backfill ships with it. Before this, a payload
 * pairing a non-terminal status with an end wrote that end onto a live row and
 * NOTHING could take it off again: max-wins refuses the later null, and
 * {@link resolveGuardedStatus} keeps the row non-terminal, which gates out
 * `shouldReopenSession` — the one writer whose job is clearing the column. The
 * state sustained itself. Because this gate runs on every apply, an
 * already-poisoned row is corrected by its own next sync: the repair path is the
 * ordinary write path, not a migration over historical rows.
 *
 * Pure, and it takes the RESOLVED status as an argument rather than deriving
 * one, so a caller cannot gate on a different value than the one it writes.
 */
export function resolveSessionEndForStatus(
  sessionEndedAt: Date | null,
  resolvedStatus: SessionStatus
): Date | null {
  if (TERMINAL_SESSION_STATUSES.has(resolvedStatus)) {
    return sessionEndedAt;
  }
  return null;
}

/**
 * ISS-8681: the `sessionEndedAt` a write may take from the payload at all,
 * applied to the INCOMING value before {@link resolveGuardedTimestampPatch}.
 *
 * Every direct reader of `sessionEndedAt` — the Duration comparator's span
 * bound, the `endedAt` wire field, a branch's completion filter — is
 * deliberately clock-free: each measures activity or duration against the
 * stored end, never against the real clock. An `endedAt` years ahead of real
 * time therefore reads as decisive proof the run is long over while it may
 * still be running, and nothing downstream can reject the value itself —
 * {@link MAX_TRUSTED_FUTURE_SKEW_MS} lives in `apps/api` and a package cannot
 * import from an app — so the refusal belongs here, on the write path, where
 * the constant is already in scope.
 *
 * INCOMING, not the max-wins result, and the difference is load-bearing: a
 * future instant always wins that comparison, so gating the result would let a
 * poisoned payload delete a legitimate stored end. The cost of that choice,
 * stated rather than left to be discovered: a row that ALREADY holds such an end
 * keeps it, because max-wins never walks the column back. That is the same
 * permanence {@link resolveGuardedTimestampPatch} already documents for the
 * poisoned start/end pair, and undoing it is a migration rather than a gate.
 *
 * Never silently coerced — but NOT via the commit read-back, which cannot see
 * this refusal at all. {@link didDropContradictorySessionEnd} fires only on a
 * committed NULL, and the very preservation above means an already-ended row
 * commits the STORED end, so the refusal would read as "no refusal" for exactly
 * the repeat-offender producers worth chasing. This gate therefore reports
 * itself, through {@link didRefuseImplausibleSessionEnd}.
 */
export function resolveStorableSessionEnd(
  sessionEndedAt: Date | null,
  receivedAt: Date
): Date | null {
  if (isImplausiblyFutureSessionEndedAt(sessionEndedAt, receivedAt)) {
    return null;
  }
  return sessionEndedAt;
}

/**
 * ISS-8681: whether {@link resolveStorableSessionEnd} refused an end the payload
 * carried — the second producer of
 * `SessionSyncMetric.ContradictorySessionEndDropped`.
 *
 * Reported from the GATE rather than from the commit read-back its sibling
 * {@link didDropContradictorySessionEnd} uses, because the read-back is blind to
 * this refusal on the case that matters most. When the row already stores a
 * legitimate end, max-wins hands the write that stored value once this gate has
 * nulled the incoming one, so the column commits NON-null and the read-back
 * concludes nothing was refused — under-counting precisely the sustained
 * clock-skewed producer the counter exists to name.
 *
 * Both arguments come from before the upsert, so this says nothing about which
 * arm committed, and it does not need to: the gate runs ahead of the arm split
 * and both arms read its output.
 */
export function didRefuseImplausibleSessionEnd(
  payloadSessionEndedAt: Date | null,
  storableSessionEndedAt: Date | null
): boolean {
  return payloadSessionEndedAt !== null && storableSessionEndedAt === null;
}

/**
 * ISS-8552: whether one apply refused an end THE PAYLOAD CARRIED — the
 * diagnostic behind `SessionSyncMetric.ContradictorySessionEndDropped`.
 *
 * Both arguments are deliberate, and neither may be substituted (whitlockk /
 * chatgpt-codex-connector, PR #6284):
 *
 * - `incomingSessionEndedAt` is the end THIS DELIVERY sent — never the max-wins
 *   resolution, and (ISS-8681) never the value {@link resolveStorableSessionEnd}
 *   already gated, which would report every implausible end as no end at all.
 *   The metric names a producer, so it must not fire on a payload
 *   that carried no end: an already-stranded row repairs on an ordinary clean
 *   sync (`{active, endedAt: null}`), and max-wins hands that write the STORED
 *   end, which the gate then drops. Reading the resolved value would report that
 *   repair as a contradictory payload and send operators after a producer that
 *   sent nothing wrong.
 *
 * - `committedSessionEndedAt` is read back off the upsert, so the branch that
 *   ACTUALLY COMMITTED is what answers. The slice's `existing` read cannot:
 *   which arm runs is decided by the database (see the create arm's ISS-5648
 *   note), so a sweep deleting the row between that read and the upsert lands on
 *   CREATE while `existing` still says update — and that create arm can drop an
 *   end the update arm would have kept. Selecting the branch from the stale read
 *   silently misses it.
 *
 * Sound because max-wins is unconditional (`maxDate`): a non-null STORABLE end
 * always resolves non-null on both arms, so a committed null with a non-null
 * incoming end can only be a refusal, never the watermark or a tie.
 *
 * ISS-8681 narrowed what that refusal can be. This predicate now detects the
 * STATUS refusal only ({@link resolveSessionEndForStatus}); the skew refusal is
 * invisible here, because {@link resolveStorableSessionEnd} runs BEFORE max-wins
 * and an already-ended row therefore commits its stored end. That refusal is
 * reported by {@link didRefuseImplausibleSessionEnd} instead, and the caller ORs
 * the two into the one counter — the reasons differ but the actionable fact does
 * not: a producer sent an end the ingest would not store.
 *
 * Read BEFORE `maybeReopenTerminalSession`, which clears the column as its own
 * legitimate job rather than as a refusal.
 */
export function didDropContradictorySessionEnd(
  incomingSessionEndedAt: Date | null,
  committedSessionEndedAt: Date | null
): boolean {
  return incomingSessionEndedAt !== null && committedSessionEndedAt === null;
}

/**
 * ISS-8733 (review: davetho): precedence between a SYNCED name override and a
 * rename made through `PATCH /agent-sessions/[id]`.
 *
 * SYNC MAY SEED, ONLY THE OWNER MAY REPLACE. The payload's override lands only
 * on a row that holds none; a stored value is never overwritten by ingest. Two
 * refusals, for two different reasons, and the second is the one this ticket
 * added:
 *
 * - NOTHING ON THE WIRE (ISS-8717). An older desktop, and any desktop with
 *   nothing to report, makes no claim about the name, so an unconditional key
 *   would put that absence on the column and erase the rename on the very next
 *   sync. This refusal is the half only the caller can make, because the wire
 *   value is not in the row.
 * - SOMETHING ALREADY STORED. That value is the owner's, and
 *   `sessionRenameService` is its only other writer. The watermark cannot
 *   adjudicate this one: the rename deliberately does not move
 *   `sessionUpdatedAt`, so an at-least-once redelivery of the batch the rename
 *   raced replays at an EQUAL watermark — which `shouldUpdateGuardedColumns`
 *   admits (`>=`) — and the collector's stale name would win by arrival order.
 *   Seeding-only is therefore strictly stronger than gating on freshness here,
 *   and is why this is not just another guarded column.
 *
 * THIS FUNCTION IS NOT THE ENFORCER OF THE SECOND REFUSAL (ISS-8732 review:
 * davetho). `storedNameOverride` is a read, and any read taken before the
 * write can be stale by the time the write lands — `sessionRenameService` shares
 * no advisory lock with the sync transaction. `upsertSessionSlice` therefore
 * applies the result through a `nameOverride: null` predicate so the database
 * re-checks the column at the write; passing the committed value here only lets
 * the common case skip that statement.
 *
 * The consequence, stated rather than left to be discovered: a desktop-ORIGINATED
 * re-rename cannot land through this path. Nothing in `apps/desktop` writes
 * `sessions.name_override` today, so there is no such payload to lose; a desktop
 * rename lane would need its own precedence signal (a rename watermark), not
 * this seed.
 */
export function resolveNameOverridePatch(
  incomingNameOverride: string | null | undefined,
  storedNameOverride: string | null | undefined
): { nameOverride?: string } {
  if (!incomingNameOverride || storedNameOverride) {
    return {};
  }
  return { nameOverride: incomingNameOverride };
}

/**
 * ISS-10332 / PLN-2086: the priority a synced payload may SEED — the
 * `resolveNameOverridePatch` rule applied to `artifacts.priority`. A desktop
 * priority is set offline and carries no precedence signal, so it is adopted
 * only while the cloud artifact holds none: the caller writes this patch
 * through a `priority: null` predicate, so a value set on the web is never
 * overwritten. An absent or null incoming value is no claim and yields no
 * patch, so it can never clear one either.
 */
export function resolvePriorityPatch(incoming: Priority | null | undefined): {
  priority?: Priority;
} {
  return incoming ? { priority: incoming } : {};
}

/**
 * ISS-8515: the token-rollup patch a write arm may apply, given freshness.
 *
 * Extracted rather than inlined as a ternary in each arm because the
 * pre-ISS-8619 `upsertSessionSlice` sat at the cognitive-complexity ceiling;
 * two inline conditionals pushed it to 22 against a max of 20. The phase split
 * relieved that pressure; the paragraph below is why it stays extracted.
 *
 * Both arms take the SAME flag deliberately. The update arm needs it so a stale
 * batch cannot clobber a newer authoritative cost. The create arm needs it for
 * the READ COMMITTED race (ISS-5648) where a stale slice still reaches the create
 * arm because its row was concurrently deleted — there the per-model write is
 * suppressed by this same flag, so letting the parent counts through would leave
 * the rollup and the per-model table disagreeing, which is precisely what
 * ruling 1 forbids.
 */
export function gateTokenRollupColumns(
  columns: TokenRollupColumns,
  shouldUpdateGuardedColumns: boolean
): TokenRollupColumns {
  return shouldUpdateGuardedColumns ? columns : {};
}
