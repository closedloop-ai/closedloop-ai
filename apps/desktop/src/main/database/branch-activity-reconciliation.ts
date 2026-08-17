import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS,
  MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import {
  type ResolvedBranchActivityCarrier,
  resolveBranchActivityCarriers,
} from "./branch-activity-carriers.js";
import {
  branchActivityLookupKey,
  normalizeActivityBranchName,
  normalizeActivityRepository,
} from "./branch-activity-identity.js";
import type { BranchActivityReadRawRow } from "./branch-activity-query.js";
import type {
  BranchCanonicalActivityKey,
  BranchCanonicalActivityRow,
} from "./branch-activity-read.js";

/** Reconcile bounded carrier rows to one latest evidence row per Branch. */
export function reconcileBranchActivityRows(
  rawRows: readonly BranchActivityReadRawRow[]
): BranchCanonicalActivityRow[] {
  const carriers = resolveBranchActivityCarriers(rawRows);
  return projectLatestRows(reconcileSessions(carriers));
}

function reconcileSessions(
  carriers: readonly ResolvedBranchActivityCarrier[]
): BranchEvidenceStateMap {
  const states: BranchEvidenceStateMap = new Map();
  const globalEvents = new Map<string, ReconciledEvent>();
  const globalConflicts = new Set<string>();
  const bySession = groupBy(carriers, (carrier) => carrier.sessionId);

  for (const sessionCarriers of bySession.values()) {
    const session = reconcileSession(sessionCarriers);
    for (const issue of session.issues) {
      addCoverageIssue(states, issue.branch, issue.id);
    }
    for (const event of session.events) {
      addGlobalEvent(states, globalEvents, globalConflicts, event);
    }
  }
  return states;
}

function reconcileSession(
  carriers: readonly ResolvedBranchActivityCarrier[]
): SessionEvidence {
  const issues: CoverageIssue[] = [];
  const eventsBySource = new Map<string, ReconciledEvent>();
  const conflicts = new Set<string>();
  for (const carrier of carriers) {
    if (!carrier.activity) {
      if (!carrier.carrierOverflow) {
        issues.push({
          branch: carrier.branch,
          id: `malformed-carrier:${carrier.carrierId}`,
        });
      }
      continue;
    }
    for (const event of carrier.activity.events) {
      addSessionEvent(eventsBySource, conflicts, issues, carrier.branch, event);
    }
  }

  let ranked = [...eventsBySource.values()].sort(compareRankedEvents);
  if (carriers.some((carrier) => carrier.carrierOverflow)) {
    const sessionId = carriers[0]?.sessionId ?? "unknown";
    addIssueForEveryCarrierBranch(issues, carriers, `carrier-cap:${sessionId}`);
    ranked = ranked.map(markEventPartial);
  }
  if (
    ranked.length > MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION
  ) {
    const sessionId = carriers[0]?.sessionId ?? "unknown";
    addIssueForEveryCarrierBranch(issues, carriers, `session-cap:${sessionId}`);
    ranked = ranked
      .slice(0, MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION)
      .map(markEventPartial);
  }
  return {
    events: capEventsPerTarget(ranked, issues),
    issues,
  };
}

function addSessionEvent(
  events: Map<string, ReconciledEvent>,
  conflicts: Set<string>,
  issues: CoverageIssue[],
  branch: BranchCanonicalActivityKey,
  event: SyncedMonitoredSessionActivityEvent
): void {
  const sourceKey = eventLookupKey(branch, event.sourceEventId);
  if (conflicts.has(sourceKey)) {
    return;
  }
  const candidate = { ...branch, ...event };
  const existing = events.get(sourceKey);
  if (!existing) {
    events.set(sourceKey, candidate);
    return;
  }
  if (sameEvent(existing, candidate)) {
    if (candidate.completeness === BranchActivityEvidenceCompleteness.Partial) {
      events.set(sourceKey, markEventPartial(existing));
    }
    return;
  }
  events.delete(sourceKey);
  conflicts.add(sourceKey);
  issues.push({ branch, id: `conflicting-source:${event.sourceEventId}` });
}

function capEventsPerTarget(
  events: readonly ReconciledEvent[],
  issues: CoverageIssue[]
): ReconciledEvent[] {
  const capped: ReconciledEvent[] = [];
  const byTarget = groupBy(events, (event) => branchLookupKey(event));
  for (const targetEvents of byTarget.values()) {
    const ranked = targetEvents.sort(compareRankedEvents);
    if (ranked.length <= MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS) {
      capped.push(...ranked);
      continue;
    }
    const branch = ranked[0];
    if (branch) {
      issues.push({
        branch,
        id: `target-cap:${branchLookupKey(branch)}`,
      });
    }
    capped.push(
      ...ranked
        .slice(0, MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS)
        .map(markEventPartial)
    );
  }
  return capped;
}

function addGlobalEvent(
  states: BranchEvidenceStateMap,
  events: Map<string, ReconciledEvent>,
  conflicts: Set<string>,
  event: ReconciledEvent
): void {
  const state = branchState(states, event);
  if (event.completeness === BranchActivityEvidenceCompleteness.Partial) {
    state.issueIds.add(`partial-source:${event.sourceEventId}`);
  }
  const sourceKey = eventLookupKey(event, event.sourceEventId);
  if (conflicts.has(sourceKey)) {
    return;
  }
  const existing = events.get(sourceKey);
  if (!existing) {
    events.set(sourceKey, event);
    state.events.set(event.sourceEventId, event);
    return;
  }
  if (sameEvent(existing, event)) {
    if (event.completeness === BranchActivityEvidenceCompleteness.Partial) {
      const partial = markEventPartial(existing);
      events.set(sourceKey, partial);
      state.events.set(event.sourceEventId, partial);
    }
    return;
  }
  events.delete(sourceKey);
  state.events.delete(event.sourceEventId);
  state.issueIds.add(`conflicting-source:${event.sourceEventId}`);
  conflicts.add(sourceKey);
}

function projectLatestRows(
  states: BranchEvidenceStateMap
): BranchCanonicalActivityRow[] {
  return [...states.values()]
    .map(projectLatestRow)
    .filter((row): row is BranchCanonicalActivityRow => row !== undefined)
    .sort(compareOutputRows);
}

function projectLatestRow(
  state: BranchEvidenceState
): BranchCanonicalActivityRow | undefined {
  const latest = [...state.events.values()].sort(compareRankedEvents).at(0);
  if (latest) {
    return {
      ...state.branch,
      sourceEventId: latest.sourceEventId,
      occurredAt: latest.occurredAt,
      completeness:
        state.issueIds.size > 0
          ? BranchActivityEvidenceCompleteness.Partial
          : BranchActivityEvidenceCompleteness.Complete,
    };
  }
  const sourceEventId = [...state.issueIds].sort().at(0);
  return sourceEventId
    ? {
        ...state.branch,
        sourceEventId,
        occurredAt: null,
        completeness: BranchActivityEvidenceCompleteness.Partial,
      }
    : undefined;
}

function addCoverageIssue(
  states: BranchEvidenceStateMap,
  branch: BranchCanonicalActivityKey,
  id: string
): void {
  branchState(states, branch).issueIds.add(id);
}

function branchState(
  states: BranchEvidenceStateMap,
  branch: BranchCanonicalActivityKey
): BranchEvidenceState {
  const key = branchLookupKey(branch);
  const existing = states.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    branch: {
      repoFullName: branch.repoFullName,
      branchName: branch.branchName,
    },
    events: new Map<string, ReconciledEvent>(),
    issueIds: new Set<string>(),
  };
  states.set(key, created);
  return created;
}

function addIssueForEveryCarrierBranch(
  issues: CoverageIssue[],
  carriers: readonly ResolvedBranchActivityCarrier[],
  id: string
): void {
  for (const branch of uniqueCarrierBranches(carriers)) {
    issues.push({ branch, id });
  }
}

function uniqueCarrierBranches(
  carriers: readonly ResolvedBranchActivityCarrier[]
): BranchCanonicalActivityKey[] {
  return [
    ...new Map(
      carriers.map((carrier) => [
        branchLookupKey(carrier.branch),
        carrier.branch,
      ])
    ).values(),
  ];
}

function branchLookupKey(branch: BranchCanonicalActivityKey): string {
  const repoFullName = normalizeActivityRepository(branch.repoFullName);
  const branchName = normalizeActivityBranchName(branch.branchName);
  return branchActivityLookupKey({
    repoFullName: repoFullName ?? "",
    branchName: branchName ?? "",
  });
}

function eventLookupKey(
  branch: BranchCanonicalActivityKey,
  sourceEventId: string
): string {
  return `${branchLookupKey(branch)}\u0000${sourceEventId}`;
}

function compareRankedEvents(
  left: ReconciledEvent,
  right: ReconciledEvent
): number {
  return (
    Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
    branchLookupKey(left).localeCompare(branchLookupKey(right)) ||
    left.sourceEventId.localeCompare(right.sourceEventId)
  );
}

function compareOutputRows(
  left: BranchCanonicalActivityRow,
  right: BranchCanonicalActivityRow
): number {
  return (
    (left.repoFullName ?? "").localeCompare(right.repoFullName ?? "") ||
    left.branchName.localeCompare(right.branchName) ||
    left.sourceEventId.localeCompare(right.sourceEventId)
  );
}

function sameEvent(left: ReconciledEvent, right: ReconciledEvent): boolean {
  return left.kind === right.kind && left.occurredAt === right.occurredAt;
}

function markEventPartial(event: ReconciledEvent): ReconciledEvent {
  return {
    ...event,
    completeness: BranchActivityEvidenceCompleteness.Partial,
  };
}

function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

type ReconciledEvent = BranchCanonicalActivityKey &
  SyncedMonitoredSessionActivityEvent;

type CoverageIssue = {
  branch: BranchCanonicalActivityKey;
  id: string;
};

type SessionEvidence = {
  events: ReconciledEvent[];
  issues: CoverageIssue[];
};

type BranchEvidenceState = {
  branch: BranchCanonicalActivityKey;
  events: Map<string, ReconciledEvent>;
  issueIds: Set<string>;
};

type BranchEvidenceStateMap = Map<string, BranchEvidenceState>;
