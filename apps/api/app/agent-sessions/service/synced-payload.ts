import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionAttribution,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { syncedAgentSessionAgentSchema } from "@/lib/desktop-agent-sessions-schema";
import { toNumber } from "@/lib/prisma-number";
import {
  type JsonArrayIncompleteness,
  JsonArrayIncompleteReason,
  readJsonArray,
} from "./coercion";
import type { AgentSessionDetailRecord, SessionTotals } from "./records";

/**
 * ISS-6890: the persisted agent roster, read MEMBER BY MEMBER.
 *
 * `incomplete` is OMITTED when the blob was read whole, so one truthy predicate
 * (`if (roster.incomplete)`) catches every partial read. ISS-7062 replaced a
 * local `unreadableAgents: number | null` with the canonical
 * {@link JsonArrayIncompleteness}: under that shape the WORST case — the blob
 * was not an array, so the lost count is unknowable — was the one that read as
 * "fine" under `!= null`, `??`, and truthiness. Here an unknowable count carries
 * no number at all, and completeness is the ABSENCE of a field rather than a
 * value a caller has to remember to compare against `0`.
 *
 * SCOPE: this function judges the COLUMN IN ISOLATION and nothing else. A whole
 * read here is not yet "the roster is whole" — the stored `agentCount` is a
 * separate surviving column this parser cannot see, and only reconciling the two
 * decides completeness. That is {@link reconcileAgentRoster}'s job, at the
 * projection boundary where both are in scope. An absent column therefore reads
 * whole here and is settled there: absent beside `agentCount: 0` is an
 * empty-but-whole roster, absent beside a positive `agentCount` is a roster that
 * was lost.
 *
 * (Superseded, #5209 review: this docstring used to rule that an absent column
 * is NEVER corruption because "nothing was ever captured". That rule is true of
 * the column alone and false of the record — "nothing was ever captured" and
 * "the count says N" cannot both hold — so the cross-check now decides, and this
 * parser no longer claims completeness it has no evidence for.)
 *
 * The pre-ISS-6890 read safe-parsed the WHOLE array and returned `[]` when any
 * one member failed. That is the coercion the root `AGENTS.md` bad-data rule
 * forbids twice over: it discarded members the code could read perfectly well,
 * and the `[]` it substituted is a plausible-but-wrong value — `agentCount` is a
 * separate stored column that survives untouched, so one version-skewed member
 * made a session report N agents and an empty roster at the same time.
 */
export type SyncedAgentRoster = {
  agents: SyncedAgentSessionAgent[];
  /** Omitted when the stored blob was read whole. */
  incomplete?: JsonArrayIncompleteness;
};

/**
 * A roster whose readable members have been reconciled against the session's own
 * stored `agentCount` (#5209 review).
 *
 * `countShortfall` is `true` only when the SHORTFALL — not a parse failure — is
 * what made this roster incomplete: every member the blob held was readable, and
 * there were still fewer of them than the count says the session has. It is the
 * distinction the diagnostic needs, because it is a different operator
 * instruction: a member shape this build cannot model versus members that never
 * reached the column at all.
 */
export type ReconciledAgentRoster = SyncedAgentRoster & {
  countShortfall: boolean;
};

/**
 * Cross-check a parsed roster against the session's stored `agentCount`, the
 * separate column that survives whatever happened to the blob.
 *
 * WHY THIS EXISTS (#5209 review). Reading the column in isolation cannot see the
 * contradiction ISS-6890 is about. A `null` column, an empty array, and a short
 * but perfectly valid array all parse without a single failure, so
 * {@link toSyncedAgentRoster} reports a WHOLE read and the projection served
 * `agents: []` beside `agentCount: 5` with nothing marking it incomplete — the
 * exact false-completeness the ticket set out to remove, arrived at by a
 * different route. The count is only in scope here, at the projection boundary.
 *
 * The shortfall is used as a LOWER BOUND, never a replacement: the reported
 * `unreadableMembers` becomes `max(parse failures, agentCount - readable
 * members)`, so a roster that lost members BOTH ways reports the larger, honest
 * loss. A roster with at least as many readable members as the count is left
 * whole — a count that lags the blob is not evidence of loss, and inventing
 * incompleteness from it would make the marker meaningless. An unreadable blob
 * keeps `unreadable_value`: the count cannot make an unknowable number known,
 * and that reason is already the strongest statement.
 */
export function reconcileAgentRoster(
  roster: SyncedAgentRoster,
  agentCount: number
): ReconciledAgentRoster {
  const incomplete = roster.incomplete;
  if (incomplete?.reason === JsonArrayIncompleteReason.UnreadableValue) {
    return { ...roster, countShortfall: false };
  }
  const unreadableMembers = incomplete?.unreadableMembers ?? 0;
  const shortfall = agentCount - roster.agents.length;
  if (shortfall <= unreadableMembers) {
    return { ...roster, countShortfall: false };
  }
  return {
    agents: roster.agents,
    incomplete: {
      reason: JsonArrayIncompleteReason.UnreadableMembers,
      unreadableMembers: shortfall,
    },
    countShortfall: unreadableMembers === 0,
  };
}

/**
 * ISS-7062: the roster read is now a thin DOMAIN WRAPPER over the canonical
 * {@link readJsonArray}, not a second hand-rolled member-wise reader. The
 * absent / empty / corrupt / partial distinctions are the canonical helper's,
 * so they cannot drift from the other persisted-array reads in this service.
 */
export function toSyncedAgentRoster(value: unknown): SyncedAgentRoster {
  const read = readJsonArray<SyncedAgentSessionAgent>(
    value,
    syncedAgentSessionAgentSchema
  );
  return read.incomplete === undefined
    ? { agents: read.members }
    : { agents: read.members, incomplete: read.incomplete };
}

/**
 * The WIRE encoding of an incompleteness: how many stored members were lost, or
 * `null` when the blob was not an array and the lost count is unknowable.
 *
 * `null` is only safe here because every field this feeds
 * (`rosterIncomplete`, `agentRosterIncomplete`) is OMITTED when the read was
 * whole. The PARENT's presence is what says "incomplete" — this number never
 * carries that fact, so it cannot be read as "fine". Do not lift it to a
 * top-level field, where `null` would become the false-completeness signal
 * ISS-7062 removed from the domain type.
 */
export function toUnreadableAgents(
  incomplete: JsonArrayIncompleteness
): number | null {
  return incomplete.reason === JsonArrayIncompleteReason.UnreadableMembers
    ? incomplete.unreadableMembers
    : null;
}

/**
 * The detail projection's SPREAD-SHAPED incompleteness signal (`{}` when the
 * roster is whole), so `rosterIncomplete` stays genuinely OMITTED on the served
 * object rather than serialized as a present falsy value — absence is the contract's
 * only encoding of "complete". Same shape, and the same two reasons, as
 * {@link toBoundedDetailEvents}'s `truncation`: it also keeps the branch out of
 * `findSessionDetail`, which sits at the cognitive-complexity ceiling.
 */
export function toRosterIntegrity(roster: SyncedAgentRoster): {
  rosterIncomplete?: { unreadableAgents: number | null };
} {
  const incomplete = roster.incomplete;
  return incomplete === undefined
    ? {}
    : {
        rosterIncomplete: { unreadableAgents: toUnreadableAgents(incomplete) },
      };
}

export function toTokenUsageBreakdown(
  rows: AgentSessionDetailRecord["tokenUsageByModel"]
): SyncedAgentSessionTokenUsage[] {
  return rows.map((row) => ({
    model: row.model,
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    cacheReadTokens: toNumber(row.cacheReadTokens),
    cacheWriteTokens: toNumber(row.cacheWriteTokens),
    // FEA-3419: typed TTL subdivision; null = never reported (absent).
    cacheWrite5mTokens:
      row.cacheWrite5mTokens == null ? null : toNumber(row.cacheWrite5mTokens),
    cacheWrite1hTokens:
      row.cacheWrite1hTokens == null ? null : toNumber(row.cacheWrite1hTokens),
    estimatedCostUsd: toNumber(row.estimatedCost),
  }));
}

export function normalizeTokenUsage(
  rows: readonly SyncedAgentSessionTokenUsage[]
): SyncedAgentSessionTokenUsage[] {
  const byModel = new Map<string, SyncedAgentSessionTokenUsage>();

  for (const row of rows) {
    const existing = byModel.get(row.model);
    if (!existing) {
      byModel.set(row.model, {
        ...row,
        estimatedCostUsd: row.estimatedCostUsd ?? 0,
      });
      continue;
    }

    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheWriteTokens += row.cacheWriteTokens;
    // FEA-3419: the split is present iff either side reported one (absent rows
    // contribute 0 — their cache writes stay in the unclassified residual).
    if (row.cacheWrite1hTokens != null || existing.cacheWrite1hTokens != null) {
      existing.cacheWrite5mTokens =
        (existing.cacheWrite5mTokens ?? 0) + (row.cacheWrite5mTokens ?? 0);
      existing.cacheWrite1hTokens =
        (existing.cacheWrite1hTokens ?? 0) + (row.cacheWrite1hTokens ?? 0);
    }
    existing.estimatedCostUsd =
      (existing.estimatedCostUsd ?? 0) + (row.estimatedCostUsd ?? 0);
  }

  return [...byModel.values()];
}

export function toAttribution(
  session: Pick<
    AgentSessionDetailRecord,
    "repositoryFullName" | "worktreePath" | "sourceArtifactId" | "baseBranch"
  >
): SyncedAgentSessionAttribution | null {
  const attribution: SyncedAgentSessionAttribution = {
    repositoryFullName: session.repositoryFullName,
    worktreePath: session.worktreePath,
    sourceArtifactId: session.sourceArtifactId,
    baseBranch: session.baseBranch,
  };
  return Object.values(attribution).some((value) => value != null)
    ? attribution
    : null;
}

export function sumTokenUsage(
  rows: readonly SyncedAgentSessionTokenUsage[]
): SessionTotals {
  return rows.reduce<SessionTotals>(
    (totals, row) => ({
      inputTokens: totals.inputTokens + row.inputTokens,
      outputTokens: totals.outputTokens + row.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + row.cacheWriteTokens,
      estimatedCost: totals.estimatedCost + (row.estimatedCostUsd ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    }
  );
}

/**
 * ISS-5075: project the detail's raw event rows, honoring the read cap.
 *
 * The select reads one row PAST {@link SESSION_DETAIL_EVENT_MAX_ROWS} so a read
 * that HIT the ceiling is detectable. This bounds the served set back to the cap
 * — a stable chronological PREFIX, since that select orders deterministically —
 * and reports whether it did. Reading the SSOT constant here (rather than taking
 * it as an argument) is what keeps the `take` and this bound from drifting apart.
 *
 * `truncation` is returned SPREAD-SHAPED (`{}` when the stream is complete) for
 * two reasons: the caller splats it, so `eventsTruncated` stays genuinely OMITTED
 * rather than serialized as a present falsy value (absence is the contract's only
 * encoding of "complete"), and the branch stays out of `findSessionDetail`, which
 * sits at the cognitive-complexity ceiling.
 */
export function toBoundedDetailEvents(
  rows: AgentSessionDetailRecord["events"]
): {
  events: SyncedAgentSessionEvent[];
  truncation: { eventsTruncated?: true };
} {
  // `slice` on an under-cap array is just a copy, so the bounded path needs no
  // branch — the rows are re-mapped into a new array either way.
  const events = rows
    .slice(0, SESSION_DETAIL_EVENT_MAX_ROWS)
    .map(toSyncedDetailEvent);
  return {
    events,
    truncation:
      rows.length > SESSION_DETAIL_EVENT_MAX_ROWS
        ? { eventsTruncated: true }
        : {},
  };
}

/**
 * The five-column detail event row as the cloud lane serves it. ISS-9857
 * hoisted it out of {@link toBoundedDetailEvents} so the keyset events page
 * (`session-events-page-read.ts`) maps a row with the SAME literal — the page
 * must continue the prefix exactly, so the two cannot be allowed to drift. The
 * return annotation keeps excess-property checking on the served shape, so a
 * later edit can't quietly add a desktop-local-only field to the cloud lane.
 */
export function toSyncedDetailEvent(
  row: AgentSessionDetailRecord["events"][number]
): SyncedAgentSessionEvent {
  return {
    externalEventId: row.externalEventId,
    agentExternalId: row.agentExternalId,
    eventType: row.eventType,
    toolName: row.toolName,
    createdAt: row.eventCreatedAt.toISOString(),
  };
}
