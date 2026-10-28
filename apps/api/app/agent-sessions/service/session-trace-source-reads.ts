import type {
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
} from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import {
  sessionTraceCorrectionSourceSchema,
  sessionTracePhaseSourceSchema,
  sessionTraceThrottleSourceSchema,
} from "@/lib/desktop-agent-sessions-trace-schema";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";
import {
  type JsonArrayIncompleteness,
  type JsonArrayIncompleteReason,
  readJsonArray,
} from "./coercion";

/**
 * Structured event name for the unreadable-trace-source monitor (root
 * `AGENTS.md` "Handling Bad or Nonsensical Data"). Stable snake_case on the
 * channel `apps/api` already monitors for coerced-away data, matching the live
 * `assigned_artifact_tree_truncated` precedent.
 *
 * Named for the THREE COLUMNS it actually watches, not for the defect class.
 * Silence here means "no unreadable trace-source column on a detail read IN THIS
 * WINDOW for this org and reason" — the emission is throttled, see
 * {@link UNREADABLE_SESSION_TRACE_SOURCES_WINDOW_MS}. It does NOT mean "no
 * corrupt persisted session JSON": the list-select arrays have no emission path
 * yet (see {@link readSessionTraceSources}).
 */
export const UNREADABLE_SESSION_TRACE_SOURCES_EVENT =
  "agent_session_trace_sources_unreadable";

/**
 * One emission per `(reason signature, organization)` per window. Read the
 * event as "at least one unreadable trace-source column occurred in this
 * window", never as an occurrence count — see {@link readSessionTraceSources}
 * for why a count here was never the signal.
 */
export const UNREADABLE_SESSION_TRACE_SOURCES_WINDOW_MS = 60_000;

/** Distinct organizations tracked before least-recently-used eviction. */
export const UNREADABLE_SESSION_TRACE_SOURCES_MAX_ENTRIES = 10_000;

export type UnreadableJsonArrayContext = {
  organizationId: string;
  sessionId: string;
};

type TraceSourceRecord = {
  tracePhaseSources: unknown;
  throttleSources: unknown;
  correctionSources: unknown;
};

/**
 * Project the three persisted session-trace source arrays for the detail read,
 * preserving every readable member (ISS-6978) and raising ONE monitored event
 * per detail request when any of the three could not be read whole.
 *
 * The corrupt value is persisted and never self-heals, so it is re-read on every
 * authenticated GET of the affected session. The emission is therefore
 * aggregated to one event per request covering all three arrays rather than one
 * per array — the same cadence `assigned_artifact_tree_truncated` already ships
 * on — and then bounded ACROSS requests by a fixed-window budget, so log volume
 * tracks the defect rather than the request rate.
 *
 * The budget is keyed on `(reason signature, organizationId)` and NOT on
 * `sessionId`. A session-keyed budget is defeated by exactly the traffic it is
 * meant to bound: a caller cycling more distinct corrupt sessions than the
 * entry cap evicts its own key before reuse and emits every time. The org and
 * the reason are both stable under that churn, so the key is resolved and
 * charged BEFORE any per-session correlation is built.
 *
 * Throttling loses no signal that existed. The suppressed repeats were the same
 * persisted corruption re-read, so their volume measured GET traffic, never
 * defect count — a monitor summing them would have been counting requests. A
 * new reason on the same org still emits immediately, because the reason is
 * part of the key rather than folded into one per-org bucket.
 *
 * SCOPE, stated because a monitor's silence is read as evidence. These three
 * columns are in the DETAIL select only (`records.ts`). The list select carries
 * a different set — `activityBuckets`, `markers`, `throttles`, `phases`,
 * `phaseLoopbacks`, `pullRequests` — read through `toSessionListItem`, which
 * takes no request context and runs once PER ROW, so it has no organization to
 * key the budget above on and no request boundary to aggregate a page's rows
 * into. Those arrays therefore emit NOTHING today; that gap is enumerated on
 * ISS-6978 rather than papered over by a broadly-named event. The three arrays'
 * incompleteness is also not carried onto the wire: their only shipped consumer
 * is the limit-dot rail, and what a partial rail should tell a reader is copy
 * plus a rendered caption — a product decision, escalated on the same ticket.
 */
export function readSessionTraceSources(
  record: TraceSourceRecord,
  context: UnreadableJsonArrayContext
): {
  tracePhaseSources: SessionTracePhaseSource[];
  throttleSources: SessionTraceThrottleSource[];
  correctionSources: SessionTraceCorrectionSource[];
} {
  const phases = readJsonArray<SessionTracePhaseSource>(
    record.tracePhaseSources,
    sessionTracePhaseSourceSchema
  );
  const throttles = readJsonArray<SessionTraceThrottleSource>(
    record.throttleSources,
    sessionTraceThrottleSourceSchema
  );
  const corrections = readJsonArray<SessionTraceCorrectionSource>(
    record.correctionSources,
    sessionTraceCorrectionSourceSchema
  );
  reportUnreadableJsonArrays(context, [
    { field: "tracePhaseSources", incomplete: phases.incomplete },
    { field: "throttleSources", incomplete: throttles.incomplete },
    { field: "correctionSources", incomplete: corrections.incomplete },
  ]);
  return {
    tracePhaseSources: phases.members,
    throttleSources: throttles.members,
    correctionSources: corrections.members,
  };
}

type ReadReport = {
  field: string;
  incomplete: JsonArrayIncompleteness | undefined;
};

/**
 * Raise one monitored event for the fields that could not be read whole, or
 * stay silent when every field was whole or the window's budget is spent.
 * `field` values are compile-time literals, never caller-controlled, so the
 * emitted cardinality is fixed.
 */
function reportUnreadableJsonArrays(
  context: UnreadableJsonArrayContext,
  reads: readonly ReadReport[]
): void {
  const unreadable = reads.filter(
    (read): read is { field: string; incomplete: JsonArrayIncompleteness } =>
      read.incomplete !== undefined
  );
  if (unreadable.length === 0) {
    return;
  }
  const budgetKey = buildEmissionKey(
    context.organizationId,
    unreadable.map((read) => read.incomplete.reason)
  );
  if (!emissionBudget.attempt(budgetKey, Date.now())) {
    return;
  }
  log.warn(UNREADABLE_SESSION_TRACE_SOURCES_EVENT, {
    organizationId: context.organizationId,
    sessionId: context.sessionId,
    fields: unreadable.map((read) => ({
      field: read.field,
      ...read.incomplete,
    })),
  });
}

/**
 * Process-local emission budget, one event per key per window. Best-effort and
 * ephemeral per serverless instance, exactly like the sibling limiters in
 * `apps/api/lib` — each instance dedups independently, which is enough to stop
 * a single hot instance turning one corrupt column into request-rate log
 * volume. Reused rather than reimplemented so this does not fork a second copy
 * of the fixed-window mechanism.
 */
const emissionBudget = new FixedWindowRateLimiter({
  maxEntries: UNREADABLE_SESSION_TRACE_SOURCES_MAX_ENTRIES,
  maxRequests: 1,
  windowMs: UNREADABLE_SESSION_TRACE_SOURCES_WINDOW_MS,
});

/**
 * Reset the process-local budget. For tests, which must not inherit another
 * spec's spent window.
 */
export function resetUnreadableTraceSourceEmissionBudget(): void {
  emissionBudget.clear();
}

/** Separates the fixed-cardinality reason signature from the organization id. */
const EMISSION_KEY_DELIMITER = "|";

/**
 * `(reason signature, organizationId)`, deliberately in that order: the
 * signature is drawn from a fixed, closed set, so the segment before the FIRST
 * delimiter is unambiguous no matter what an organization id contains. Keying
 * the other way round would let a crafted id straddle the delimiter and charge
 * another organization's budget.
 *
 * Reasons are deduped and sorted so the same set of unreadable lanes resolves
 * to one key regardless of which column reported first.
 */
function buildEmissionKey(
  organizationId: string,
  reasons: readonly JsonArrayIncompleteReason[]
): string {
  const signature = [...new Set(reasons)].sort().join("+");
  return `${signature}${EMISSION_KEY_DELIMITER}${organizationId}`;
}
