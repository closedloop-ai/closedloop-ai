import { z } from "zod";
import { BranchActivityEvidenceCompleteness } from "./branch-activity.ts";

/** Qualifying monitored-session observations attached to an exact Branch/PR ref. */
export const MonitoredSessionActivityEventKind = {
  UserReference: "user_reference",
  AgentRead: "agent_read",
  AgentAction: "agent_action",
} as const;
export type MonitoredSessionActivityEventKind =
  (typeof MonitoredSessionActivityEventKind)[keyof typeof MonitoredSessionActivityEventKind];

/** Per-target bound for monitored-session activity carried by one artifact ref. */
export const MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS = 50 as const;
/** Aggregate bound across every monitored target carried by one Session. */
export const MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION =
  100 as const;
/** Raw compatibility budget validated before the retained-event cap is applied. */
export const MAX_RAW_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS = 200 as const;

const monitoredSessionActivityEventSchema = z
  .object({
    kind: z.enum(MonitoredSessionActivityEventKind),
    sourceEventId: z.string().trim().min(1).max(300),
    occurredAt: z.iso.datetime(),
    completeness: z.union([
      z.literal(BranchActivityEvidenceCompleteness.Complete),
      z.literal(BranchActivityEvidenceCompleteness.Partial),
    ]),
  })
  .strict();

export type SyncedMonitoredSessionActivityEvent = z.infer<
  typeof monitoredSessionActivityEventSchema
>;

export type SyncedMonitoredSessionActivity = {
  completeness:
    | typeof BranchActivityEvidenceCompleteness.Complete
    | typeof BranchActivityEvidenceCompleteness.Partial;
  events: SyncedMonitoredSessionActivityEvent[];
};

const compatibilitySchema = z
  .object({
    completeness: z.unknown().optional(),
    events: z.unknown(),
  })
  .passthrough();

/**
 * Preserve valid siblings in an additive carrier while dropping malformed,
 * conflicting, unknown, and over-cap entries as explicitly partial evidence.
 */
export function normalizeSyncedMonitoredSessionActivity(
  value: unknown
): SyncedMonitoredSessionActivity | undefined {
  const carrier = compatibilitySchema.safeParse(value);
  if (!(carrier.success && Array.isArray(carrier.data.events))) {
    return undefined;
  }

  let degraded =
    carrier.data.completeness !== BranchActivityEvidenceCompleteness.Complete ||
    carrier.data.events.length > MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS;
  const bySourceEventId = new Map<
    string,
    SyncedMonitoredSessionActivityEvent
  >();
  const conflictingIds = new Set<string>();
  for (const candidate of carrier.data.events.slice(
    0,
    MAX_RAW_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS
  )) {
    const parsed = monitoredSessionActivityEventSchema.safeParse(candidate);
    if (!parsed.success) {
      degraded = true;
      continue;
    }
    if (
      parsed.data.completeness === BranchActivityEvidenceCompleteness.Partial
    ) {
      degraded = true;
    }
    if (conflictingIds.has(parsed.data.sourceEventId)) {
      degraded = true;
      continue;
    }
    const existing = bySourceEventId.get(parsed.data.sourceEventId);
    if (!existing) {
      bySourceEventId.set(parsed.data.sourceEventId, parsed.data);
      continue;
    }
    if (
      existing.kind === parsed.data.kind &&
      existing.occurredAt === parsed.data.occurredAt &&
      existing.completeness === parsed.data.completeness
    ) {
      continue;
    }
    degraded = true;
    bySourceEventId.delete(parsed.data.sourceEventId);
    conflictingIds.add(parsed.data.sourceEventId);
  }

  const events = [...bySourceEventId.values()].sort(
    (left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
      left.sourceEventId.localeCompare(right.sourceEventId)
  );
  if (
    carrier.data.events.length >
      MAX_RAW_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS ||
    events.length > MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS
  ) {
    degraded = true;
  }
  const retainedEvents = events.slice(
    0,
    MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS
  );
  if (retainedEvents.length === 0) {
    return undefined;
  }
  return {
    completeness: degraded
      ? BranchActivityEvidenceCompleteness.Partial
      : BranchActivityEvidenceCompleteness.Complete,
    events: degraded
      ? retainedEvents.map((event) => ({
          ...event,
          completeness: BranchActivityEvidenceCompleteness.Partial,
        }))
      : retainedEvents,
  };
}

export const syncedMonitoredSessionActivitySchema = z
  .unknown()
  .transform(normalizeSyncedMonitoredSessionActivity);
