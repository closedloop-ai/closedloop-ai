/**
 * Per-session token totals and the usage-rollup bucket primitives they feed.
 *
 * #4150: `shared-agent-sessions-api.ts` (a shrink-only grandfathered file) and
 * `shared-agent-sessions-usage-summary.ts` both import FROM here, never the
 * reverse. That direction is the invariant — it is not a dependency-free leaf,
 * and an earlier version of this docstring claiming otherwise sent ISS-9686
 * down a wrong path.
 *
 * ISS-9686: `apps/api` names this module to reconcile the Local population
 * against the Cloud one, so nothing reachable from here may depend on
 * `apps/desktop/src/server/` (the Engineer operations tree). Pinned by
 * `apps/api/__tests__/desktop-session-fold-reachability.test.ts`.
 */
import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import {
  isSubstantiveSession,
  type SessionSubstantiveCounts,
} from "@repo/api/src/agent-session-filters";
import {
  type BillingLedger,
  billingLedger,
  normalizeBillingMode,
} from "../../shared/billing-mode.js";
import {
  type SharedAgentSessionHarnessBreakdown,
  type SharedAgentSessionListItem,
  type SharedAgentSessionUsageByModel,
  UNKNOWN_HARNESS_BUCKET,
} from "../../shared/shared-agent-sessions-contract.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import {
  parseNullableSessionDate,
  parseSessionDate,
} from "./session-instant.js";

export type SessionTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  /**
   * ISS-11226 (gap tracked as ISS-8928): COST COVERAGE for `estimatedCost` —
   * how many of the members that entered this total carried a real cost
   * measurement, out of how many entered it at all. The `?? 0` that builds
   * `estimatedCost` in {@link sumTokenUsage} is lossy by construction: it folds
   * "no token-usage rows at all", "rows whose `estimatedCostUsd` is null", and
   * "rows that genuinely summed to zero" into the same `0`, and a bare number
   * cannot say which it is. These two counters carry what the sum drops.
   *
   * Shape deliberately mirrors the cloud's `locPerDollarDenominatorCost`
   * (`@repo/api/src/utils/loc-per-dollar`), which publishes the same
   * `measured`/`total` pair beside its summed cost, so the two surfaces answer
   * "was this priced?" with the same evidence rather than two spellings of it.
   * Read them through {@link totalsCostMeasured}, never by hand.
   *
   * A MEMBER is one `tokenUsageByModel` row at {@link sumTokenUsage}, and one
   * contributing total at {@link addTotals} — the counters are plain sums, so
   * the two levels compose into one rule.
   */
  costMeasuredMembers: number;
  costMembers: number;
};

export function sumTokenUsage(session: SyncedAgentSession): SessionTotals {
  return session.tokenUsageByModel.reduce<SessionTotals>((totals, usage) => {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.estimatedCost += usage.estimatedCostUsd ?? 0;
    totals.costMembers += 1;
    // ISS-11226: finite, not merely non-null. A `NaN`/`Infinity` cost poisons the
    // sum into a value the downstream `Number.isFinite` guards already reject,
    // so it is not a measurement either — the whole impossible set, not the half
    // that is easy to remember. The ARITHMETIC above is deliberately unchanged:
    // this counts what the sum cannot say, it does not restate the sum.
    if (Number.isFinite(usage.estimatedCostUsd)) {
      totals.costMeasuredMembers += 1;
    }
    return totals;
  }, zeroTotals());
}

export function addTotals(target: SessionTotals, next: SessionTotals): void {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
  target.cacheReadTokens += next.cacheReadTokens;
  target.cacheWriteTokens += next.cacheWriteTokens;
  target.estimatedCost += next.estimatedCost;
  // ISS-11226: combining a MEASURED total with an UNMEASURED one must not yield
  // "measured". Summing the two counters is what makes that automatic: the
  // combined total is measured only once every member that entered it was
  // (see {@link totalsCostMeasured}), and `zeroTotals()` is the identity
  // because it contributes no members in either counter.
  target.costMeasuredMembers += next.costMeasuredMembers;
  target.costMembers += next.costMembers;
}

export function zeroTotals(): SessionTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    costMeasuredMembers: 0,
    costMembers: 0,
  };
}

export function countToolUseEvents(
  events: SyncedAgentSession["events"]
): number {
  return events.filter((event) => Boolean(event.toolName)).length;
}

/** Exact list count, falling back to the hydrated event fold outside the list. */
export function sessionToolUseCount(session: SyncedAgentSession): number {
  return session.listToolUseCount ?? countToolUseEvents(session.events);
}

/** Exact list count, falling back to the hydrated event fold outside the list. */
export function sessionErrorCount(session: SyncedAgentSession): number {
  return session.listErrorCount ?? countErrorEvents(session.events);
}

/**
 * ISS-4481: the session's substantive-work counts (turns/tokens/tool-uses),
 * derived from the hydrated session exactly as `mapListItem` renders them —
 * `session.turns`, the summed per-model token usage (`sumTokenUsage`), and the
 * tool-use event count (`countToolUseEvents`). Shared by the Idle badge
 * (`sessionIsSubstantive`) and the Cost filter's numeric-vs-unknown gate
 * (`matchesLocalCostBucketFilter`) so both classify a session's work identically.
 */
export function localSubstantiveCounts(
  session: SyncedAgentSession
): SessionSubstantiveCounts {
  const totals = sumTokenUsage(session);
  return {
    turns: session.turns ?? null,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    toolUseCount: sessionToolUseCount(session),
    // ISS-5801: hydrated from agent_component_invocations by sync-source.ts.
    componentInvocationCount: session.componentInvocationCount ?? null,
  };
}

/**
 * FEA-3284: whether a local session did substantive work, using the shared
 * `isSubstantiveSession` SSOT (`@repo/api/src/agent-session-filters`) — the SAME
 * predicate the cloud SQL twin encodes. The desktop `sessions` table stores no
 * turn/token/tool columns, so the signals are derived from the hydrated session
 * exactly as `mapListItem` renders them: `session.turns`, the summed per-model
 * token usage (`sumTokenUsage`), the tool-use event count
 * (`countToolUseEvents`), and the hydrated component-invocation count
 * (ISS-5801). Keeping the derivation identical to the row guarantees a session
 * buckets as idle vs substantive the same way on desktop, cloud, and the
 * shared UI.
 */
export function sessionIsSubstantive(session: SyncedAgentSession): boolean {
  return isSubstantiveSession(localSubstantiveCounts(session));
}

/**
 * ISS-6895: a session lands in exactly ONE harness bucket and reaches this
 * helper once per session (the resolved id set is deduped by `sanitizeIds`, and
 * every window visits each id once), so the bucket's distinct-session count is a
 * plain increment. It used to be `sessionIds.size` over a Set that retained one
 * id per row — an accumulator that grew with the corpus, not with the harness
 * dimension, which is exactly what the windowed fold exists to avoid.
 */
export function addSessionToHarnessBreakdown(
  byHarness: Map<string, SharedAgentSessionHarnessBreakdown>,
  session: SyncedAgentSession,
  totals: SessionTotals
): void {
  const harness = session.harness ?? UNKNOWN_HARNESS_BUCKET;
  const summary = byHarness.get(harness) ?? {
    harness,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };
  summary.sessionCount += 1;
  summary.inputTokens += totals.inputTokens;
  summary.outputTokens += totals.outputTokens;
  summary.cacheReadTokens += totals.cacheReadTokens;
  summary.cacheWriteTokens += totals.cacheWriteTokens;
  summary.estimatedCost += totals.estimatedCost;
  byHarness.set(harness, summary);
}

export function getOrCreateModelSummary(
  byModel: Map<string, SharedAgentSessionUsageByModel>,
  model: string
): SharedAgentSessionUsageByModel {
  const existing = byModel.get(model);
  if (existing) {
    return existing;
  }
  const created = {
    model,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };
  byModel.set(model, created);
  return created;
}

export function getSessionLedger(session: SyncedAgentSession): BillingLedger {
  return billingLedger(normalizeBillingMode(session.billingMode));
}

export function countErrorEvents(
  events: readonly { eventType: string }[]
): number {
  return events.filter((event) => ERROR_EVENT_PATTERN.test(event.eventType))
    .length;
}

// ISS-5801: moved from `shared-agent-sessions-api.ts` (a shrink-only
// grandfathered file), alongside the totals it consumes.
export function buildLocalSessionTimingAndUsage(
  session: SyncedAgentSession,
  totals: SessionTotals,
  updatedAt: Date,
  toolUseCount: number
): Pick<
  SharedAgentSessionListItem,
  | "agentCount"
  | "awaitingInputSince"
  | "billingMode"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "endedAt"
  | "errorCount"
  | "estimatedCost"
  | "inputTokens"
  | "lastSyncedAt"
  | "outputTokens"
  | "recordUpdatedAt"
  | "startedAt"
  | "toolUseCount"
  | "componentInvocationCount"
  | "createdAt"
  | "updatedAt"
> {
  return {
    ...(session.createdAt ? { createdAt: session.createdAt } : {}),
    startedAt: parseSessionDate(session.startedAt),
    updatedAt,
    // ISS-6005: on the LOCAL producer the row's `sessions.updated_at` IS the
    // record-mutation clock — desktop writes bump it on every row mutation
    // (status, billing-mode heal, PR-link maintenance), which is the same claim
    // the cloud's GREATEST(detail.updated_at, artifacts.updated_at) makes
    // against its store. Serves the `Updated` column in Local mode.
    recordUpdatedAt: updatedAt,
    // FEA-3479 (PRD-536 G1): the local surface has no cloud upsert time; the
    // local record's own updatedAt is the freshest "synced" moment we can honor
    // for the local SQLite producer (there is no cloud round-trip here).
    lastSyncedAt: updatedAt,
    endedAt: parseNullableSessionDate(session.endedAt),
    awaitingInputSince: parseNullableSessionDate(session.awaitingInputSince),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    estimatedCost: totals.estimatedCost,
    billingMode: session.billingMode ?? null,
    agentCount: session.listAgentCount ?? session.agents.length,
    toolUseCount,
    // ISS-5801: local↔cloud parity for the substantive-work signal (the cloud
    // list projection serves the SessionDetail column).
    componentInvocationCount: session.componentInvocationCount ?? 0,
    errorCount: sessionErrorCount(session),
  };
}

/**
 * ISS-11226: whether `totals.estimatedCost` is a MEASURED figure rather than the
 * `?? 0` stand-in for an absent one.
 *
 * SCOPE (review: whitlockk, codex). This is the TOKEN-ROW reading of that question,
 * and at the per-session boundary it is the FALLBACK, not the answer:
 * `resolveSessionCost` (`session-loc-cost.ts`) prefers the session's own
 * authoritative whole-session cost, because a web-search-only session is priced
 * entirely outside `tokenUsageByModel` and these counters cannot see it. What
 * this rule still owns is a session with no analytics rollup at all, and every
 * AGGREGATE of session totals via {@link addTotals}.
 *
 * Measured means EVERY member that entered the sum carried a real cost, and at
 * least one did. So:
 *   - no `tokenUsageByModel` rows          -> false (nothing was priced)
 *   - rows whose `estimatedCostUsd` is null -> false (they were not priced)
 *   - rows that priced out to exactly `0`   -> TRUE  (a real, free measurement)
 * The third is the case the whole defect is about: a measured $0 is a figure we
 * know, and reporting it as unknown is as wrong as reporting an unknown as $0.
 *
 * "At least one" is not a technicality: an empty sum is a zero nobody measured,
 * which is precisely the value this predicate exists to stop being published as
 * if somebody had.
 */
export function totalsCostMeasured(totals: SessionTotals): boolean {
  return (
    totals.costMembers > 0 && totals.costMeasuredMembers === totals.costMembers
  );
}
