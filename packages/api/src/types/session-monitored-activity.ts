import { z } from "zod";
import { BranchActivityEvidenceCompleteness } from "./branch-activity.ts";
import {
  type MonitoredSessionActivityEventKind as MonitoredSessionActivityEventKindType,
  MonitoredSessionActivityEventKind as monitoredSessionActivityEventKind,
} from "./branch-activity-kind.ts";

/** Qualifying monitored-session observations attached to an exact Branch/PR ref. */
export const MonitoredSessionActivityEventKind =
  monitoredSessionActivityEventKind;
export type MonitoredSessionActivityEventKind =
  MonitoredSessionActivityEventKindType;

const monitoredSessionActivityEventSchema = z
  .object({
    kind: z.enum(monitoredSessionActivityEventKind),
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
 * conflicting, and unknown entries as explicitly partial evidence. Every raw
 * entry is scanned and every valid non-conflicting event is retained (ISS-9860):
 * the desktop pages carriers across sync requests, so a count-based cap here
 * would drop the tail of a page no cursor could ever reach again.
 */
export function normalizeSyncedMonitoredSessionActivity(
  value: unknown
): SyncedMonitoredSessionActivity | undefined {
  const carrier = compatibilitySchema.safeParse(value);
  if (!(carrier.success && Array.isArray(carrier.data.events))) {
    return undefined;
  }

  let degraded =
    carrier.data.completeness !== BranchActivityEvidenceCompleteness.Complete;
  const bySourceEventId = new Map<
    string,
    SyncedMonitoredSessionActivityEvent
  >();
  const conflictingIds = new Set<string>();
  for (const candidate of carrier.data.events) {
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
      compareMonitoredActivityIdentities(
        left.sourceEventId,
        right.sourceEventId
      )
  );
  if (events.length === 0) {
    return undefined;
  }
  return {
    completeness: degraded
      ? BranchActivityEvidenceCompleteness.Partial
      : BranchActivityEvidenceCompleteness.Complete,
    events: degraded
      ? events.map((event) => ({
          ...event,
          completeness: BranchActivityEvidenceCompleteness.Partial,
        }))
      : events,
  };
}

export const syncedMonitoredSessionActivitySchema = z
  .unknown()
  .transform(normalizeSyncedMonitoredSessionActivity);

/**
 * Compare event identities by Unicode code point, the same order as SQLite's
 * UTF-8 BINARY collation for well-formed JSON strings.
 */
export function compareMonitoredActivityIdentities(
  left: string,
  right: string
): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) {
      return leftPoint - rightPoint;
    }
  }
  return leftPoints.length - rightPoints.length;
}
