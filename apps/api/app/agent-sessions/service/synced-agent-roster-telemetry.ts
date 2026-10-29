import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { JsonArrayIncompleteReason } from "./coercion";
import {
  type ReconciledAgentRoster,
  toUnreadableAgents,
} from "./synced-payload";

export const CORRUPT_AGENT_ROSTER_EVENT = "agent_session_roster_unreadable";

/**
 * How the roster failed to read. Split because each is a different operator
 * instruction: `unreadable_members` means a producer wrote a member shape this
 * build does not model and the rest of the roster survived, `unreadable_blob`
 * means the stored column is not a roster at all and nothing can be recovered —
 * including how many members were lost — and `count_shortfall` (#5209 review)
 * means every member present parsed fine and there were simply fewer of them
 * than the session's own `agentCount` says it has, so the loss happened before
 * this read rather than inside it.
 */
export const CorruptAgentRosterReason = {
  UnreadableMembers: "unreadable_members",
  UnreadableBlob: "unreadable_blob",
  CountShortfall: "count_shortfall",
} as const;
export type CorruptAgentRosterReason =
  (typeof CorruptAgentRosterReason)[keyof typeof CorruptAgentRosterReason];

export type CorruptAgentRosterContext = {
  sessionId: string;
  organizationId: string;
  /** The separate stored column the collapsed roster used to contradict. */
  agentCount: number;
};

/**
 * The STABLE half of the emission key: what an operator would act on, with no
 * per-resource component a caller can churn through.
 */
type CorruptAgentRosterScope = {
  organizationId: string;
  reason: CorruptAgentRosterReason;
};

type ThrottleKeyParts = CorruptAgentRosterScope & {
  sessionId: string;
};

/** Composite-key delimiter. No key part is a free-text field that could contain it. */
const KEY_DELIMITER = "|";

/**
 * WHY THIS IS THROTTLED. The corrupt value is PERSISTED and never self-heals, so
 * it is re-read on every authenticated `GET /agent-sessions/:id` — polling, a
 * refresh loop, or a caller replaying the route drives one emission per request,
 * indefinitely, from a single affected row. That is the amplification vector
 * `apps/api/AGENTS.md` ("Emission and Abuse Control") forbids: bound emission
 * per org/reason at the choke point and keep a bounded suppressed count.
 *
 * `FixedWindowEmissionThrottle` supplies both bounds — at most one event per
 * (org, session, reason) per window plus one aggregate rollup, and a hard
 * max-entry LRU cap on the keyspace itself, since the key is derived from
 * caller-reachable input and an unbounded map would just trade a log leak for a
 * memory leak (root `AGENTS.md`).
 *
 * WHAT THE SUPPRESSED COUNT IS WORTH (#5508 review, whitlockk). A suppressed count
 * is materialised by an event, never by a clock: the next read of the SAME
 * (org, session, reason) rolling its window over, or an LRU eviction. This
 * throttle does not wire `drainExpired` to a terminal path, so a burst followed
 * by quiet on that key stays pending in process memory until one of those two
 * happens — and a serverless instance that freezes first loses it. The monitor's
 * `sum(occurrences)` is therefore an eventual LOWER BOUND on how often the
 * corrupt row was served, not an exact live total; read it as a floor.
 *
 * That LRU cap is what makes this key alone insufficient, so
 * {@link corruptAgentRosterOrgBudget} sits in front of it — see its docstring
 * for the session-churn hole it closes.
 *
 * Process-local and best-effort per serverless instance. Exported so tests can
 * reset it between cases; production code must not reach into it.
 */
export const corruptAgentRosterThrottle =
  new FixedWindowEmissionThrottle<ThrottleKeyParts>({
    onFlush: (parts, suppressedCount, cause) =>
      emitAggregate(parts, suppressedCount, cause),
  });

/**
 * How many corrupt-roster events ONE organization may emit per reason per
 * window, across every session it owns.
 */
export const CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET = 10;

/**
 * WHY A SECOND, COARSER THROTTLE (#5209 review).
 *
 * `sessionId` in the throttle key correlates repeated reads of ONE session, but
 * it also made the bound EVICTABLE THROUGH RESOURCE CHURN: the keyspace holds
 * {@link FIXED_WINDOW_EMISSION_MAX_ENTRIES} keys, so a caller cycling one more
 * corrupt own-org session than that evicts each key before it is reused, every
 * read is a first occurrence, and the emission stream never closes. Memory was
 * bounded; log volume was not.
 *
 * This budget is keyed on `(organizationId, reason)` ALONE — no per-session
 * component — so nothing the caller varies can evict it, and it is consulted
 * BEFORE the session key so a spent budget short-circuits without touching the
 * finer map at all. Its own keyspace is bounded by the same LRU cap, over a
 * keyspace of (orgs × reasons) rather than (orgs × sessions × reasons).
 *
 * The two rollups do not double-count: an occurrence the budget refuses never
 * reaches the session throttle, so `sum(occurrences)` over both stays the true
 * number of times a corrupt roster was served. The cost is that heavy traffic on
 * ONE corrupt session can spend an org's budget for the window; the suppressed
 * count is still flushed, so the monitor sees the volume, only not the identity
 * of every session behind it.
 */
export const corruptAgentRosterOrgBudget =
  new FixedWindowEmissionThrottle<CorruptAgentRosterScope>({
    maxPerWindow: CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET,
    onFlush: (scope, suppressedCount, cause) =>
      emitAggregate(scope, suppressedCount, cause),
  });

/**
 * Emit for a detail read whose roster came back incomplete. Silent on a whole
 * roster, so the event measures corruption rather than read traffic — an event
 * on every clean read would make the monitor fire on ordinary traffic.
 *
 * Never throws. This runs inside the detail projection; a failure to REPORT the
 * corruption must not also fail the read that successfully recovered the
 * readable members. Same guard, and the same reason, as `emitFoldCount` in
 * `status-fold-telemetry.ts`.
 */
export function reportCorruptAgentRoster(
  roster: ReconciledAgentRoster,
  context: CorruptAgentRosterContext
): void {
  const incomplete = roster.incomplete;
  if (incomplete === undefined) {
    return;
  }
  const scope: CorruptAgentRosterScope = {
    organizationId: context.organizationId,
    reason: toCorruptAgentRosterReason(roster),
  };
  const parts: ThrottleKeyParts = { ...scope, sessionId: context.sessionId };

  try {
    const now = Date.now();
    // The stable budget goes FIRST, so churning `sessionId` cannot bypass it.
    const budget = corruptAgentRosterOrgBudget.record(
      buildScopeKey(scope),
      scope,
      now
    );
    if (budget.flushedSuppressedCount > 0) {
      emitAggregate(
        scope,
        budget.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (!budget.emit) {
      return;
    }
    const decision = corruptAgentRosterThrottle.record(
      buildKey(parts),
      parts,
      now
    );
    if (decision.flushedSuppressedCount > 0) {
      emitAggregate(
        parts,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      log.warn(CORRUPT_AGENT_ROSTER_EVENT, {
        ...parts,
        agentCount: context.agentCount,
        readableAgents: roster.agents.length,
        unreadableAgents: toUnreadableAgents(incomplete),
        occurrences: 1,
      });
    }
  } catch (error) {
    log.warn("[agent-sessions] Failed to report a corrupt agent roster", {
      event: CORRUPT_AGENT_ROSTER_EVENT,
      sessionId: context.sessionId,
      error: parseError(error),
    });
  }
}

/**
 * Which of the three defects this roster carries. An `unreadable_value` read is
 * the blob case; otherwise the reconciliation says whether the shortfall against
 * the stored `agentCount`, rather than a parse failure, is what made it short.
 */
function toCorruptAgentRosterReason(
  roster: ReconciledAgentRoster
): CorruptAgentRosterReason {
  if (roster.incomplete?.reason === JsonArrayIncompleteReason.UnreadableValue) {
    return CorruptAgentRosterReason.UnreadableBlob;
  }
  return roster.countShortfall
    ? CorruptAgentRosterReason.CountShortfall
    : CorruptAgentRosterReason.UnreadableMembers;
}

function buildKey(parts: ThrottleKeyParts): string {
  return [parts.organizationId, parts.sessionId, parts.reason].join(
    KEY_DELIMITER
  );
}

function buildScopeKey(scope: CorruptAgentRosterScope): string {
  return [scope.organizationId, scope.reason].join(KEY_DELIMITER);
}

/**
 * The rollup for occurrences a closed window suppressed, emitted as ONE event
 * carrying their total so `sum(occurrences)` still reflects how often the
 * corrupt roster was served. It deliberately omits the per-read roster shape —
 * the suppressed reads did not necessarily share one — and carries `aggregated`
 * so a monitor can tell a rollup from a first occurrence.
 *
 * `flushedBy` is the CAUSE the throttle reported, never a constant this module
 * picks (ISS-7360). Stamping one literal collapses a quiet key's `expiry` drain
 * into `eviction` and tells an operator the 10,000-key cap was hit when it was
 * not. `expiry` has no production call site here yet — nothing wires
 * `drainExpired` to a terminal path for this throttle — but the value is the
 * throttle's to report, not this emitter's to assume.
 */
function emitAggregate(
  parts: CorruptAgentRosterScope & { sessionId?: string },
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(CORRUPT_AGENT_ROSTER_EVENT, {
    ...parts,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
