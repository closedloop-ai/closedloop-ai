import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { monitoredActivityTargetKey } from "@repo/api/src/types/monitored-activity-target";
import {
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  compareMonitoredActivityIdentities,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

/**
 * ISS-9860: distinct monitored-activity events one sync request may carry.
 *
 * A PAGE ceiling, not a population cap: the collector persists every event and
 * the chunker ships them across as many parts as the chunk budget allows. It is
 * counted in DISTINCT `(target, sourceEventId)` events, never in carriers or
 * refs — one carrier is written onto every link row of its target, so counting
 * refs would shrink the real page by refs-per-target and could split one event
 * across two pages where the cloud's `collectCandidates` can no longer
 * reconcile the copies.
 *
 * The server does not enforce this number. Its per-event statements are chunked
 * by bind budget instead (`apps/api/app/agent-sessions/service/monitored-session-activity*.ts`).
 */
export const MONITORED_ACTIVITY_SYNC_PAGE_EVENTS = 1000;

export type MonitoredActivityPageItem = {
  targetKey: string;
  event: SyncedMonitoredSessionActivityEvent;
};

type MonitoredRef = Extract<
  SyncedArtifactRef,
  {
    kind:
      | typeof ArtifactRefTargetKind.Branch
      | typeof ArtifactRefTargetKind.PullRequest;
  }
>;

/**
 * Every distinct monitored event the session's refs carry, newest first, then
 * by target key and source event id so a re-prepare pages identically.
 *
 * Two refs of one target carry the same carrier by construction (the collector
 * builds one per target), so an identical copy of an identity is skipped rather
 * than shipped twice. A copy that DIFFERS in an immutable field is kept, and
 * both copies ride the page carrier `monitoredActivityPageRefs` builds for the
 * target: the cloud's shared normalizer
 * (`normalizeSyncedMonitoredSessionActivity`) drops a conflicting identity and
 * stamps that carrier Partial. Paging must hand it the conflict rather than
 * pick a winner and upload it as evidence.
 */
export function monitoredActivityPageItems(
  session: SyncedAgentSession
): MonitoredActivityPageItem[] {
  const byIdentity = new Map<string, MonitoredActivityPageItem[]>();
  for (const ref of session.artifactRefs ?? []) {
    if (!(isMonitoredRef(ref) && ref.monitoredSessionActivity)) {
      continue;
    }
    const targetKey = monitoredRefTargetKey(ref);
    for (const event of ref.monitoredSessionActivity.events) {
      const identity = `${targetKey}\u0000${event.sourceEventId}`;
      const copies = byIdentity.get(identity) ?? [];
      if (!copies.some((copy) => sameEvent(copy.event, event))) {
        copies.push({ targetKey, event });
        byIdentity.set(identity, copies);
      }
    }
  }
  return [...byIdentity.values()]
    .flat()
    .sort(compareMonitoredActivityPageItems);
}

/** Does the session carry more distinct monitored events than one page? */
export function exceedsMonitoredActivitySyncPage(
  session: SyncedAgentSession
): boolean {
  return (
    monitoredActivityPageItems(session).length >
    MONITORED_ACTIVITY_SYNC_PAGE_EVENTS
  );
}

/**
 * The session with every carrier removed and every activity-only ref dropped —
 * the replicated base of a split whose monitored activity ships in its own
 * pages. `artifactRefs` stays an ARRAY (possibly empty) when it was one: the
 * cloud reads an absent array as "leave links untouched" and an explicit one
 * as the session's whole reference set, and the regular refs kept here are
 * exactly the set the un-paged session would have declared.
 */
export function sessionWithoutMonitoredActivity(
  session: SyncedAgentSession
): SyncedAgentSession {
  if (!session.artifactRefs) {
    return session;
  }
  const artifactRefs: SyncedArtifactRef[] = [];
  for (const ref of session.artifactRefs) {
    if (!isMonitoredRef(ref)) {
      artifactRefs.push(ref);
      continue;
    }
    if (ref.monitoredActivityOnly === true) {
      continue;
    }
    artifactRefs.push(withoutCarrier(ref));
  }
  return { ...session, artifactRefs };
}

/**
 * The ref set one monitored page ships: every regular ref (carrier stripped
 * unless its target is in the page), plus the activity-only refs whose target
 * is in the page. Each event in the page is attached to EVERY ref of its
 * target, so the cloud sees the same per-ref shape the un-paged carrier had.
 *
 * A page carrier is `Partial` when any source carrier for that target declared
 * `Partial` — the cloud re-stamps every event of a `Partial` carrier, and paging
 * must not turn a declared-partial target into a confident one.
 */
export function monitoredActivityPageRefs(
  session: SyncedAgentSession,
  page: readonly MonitoredActivityPageItem[]
): SyncedArtifactRef[] {
  const eventsByTarget = new Map<
    string,
    SyncedMonitoredSessionActivityEvent[]
  >();
  for (const item of page) {
    const events = eventsByTarget.get(item.targetKey) ?? [];
    events.push(item.event);
    eventsByTarget.set(item.targetKey, events);
  }
  const partialTargets = new Set<string>();
  for (const ref of session.artifactRefs ?? []) {
    if (
      isMonitoredRef(ref) &&
      ref.monitoredSessionActivity?.completeness ===
        BranchActivityEvidenceCompleteness.Partial
    ) {
      partialTargets.add(monitoredRefTargetKey(ref));
    }
  }
  const refs: SyncedArtifactRef[] = [];
  for (const ref of session.artifactRefs ?? []) {
    if (!isMonitoredRef(ref)) {
      refs.push(ref);
      continue;
    }
    const targetKey = monitoredRefTargetKey(ref);
    const events = eventsByTarget.get(targetKey);
    if (!events) {
      if (ref.monitoredActivityOnly !== true) {
        refs.push(withoutCarrier(ref));
      }
      continue;
    }
    refs.push({
      ...ref,
      monitoredSessionActivity: {
        completeness: partialTargets.has(targetKey)
          ? BranchActivityEvidenceCompleteness.Partial
          : BranchActivityEvidenceCompleteness.Complete,
        events,
      },
    });
  }
  return refs;
}

/** The two ref kinds that can carry monitored-session activity. */
function isMonitoredRef(ref: SyncedArtifactRef): ref is MonitoredRef {
  return (
    ref.kind === ArtifactRefTargetKind.Branch ||
    ref.kind === ArtifactRefTargetKind.PullRequest
  );
}

/** The cloud's target identity for a monitored ref, built as `collectCandidates` builds it. */
function monitoredRefTargetKey(ref: MonitoredRef): string {
  const repositoryFullName = normalizeRepoFullName(ref.repositoryFullName);
  return monitoredActivityTargetKey(
    ref.kind === ArtifactRefTargetKind.Branch
      ? { kind: ref.kind, repositoryFullName, branchName: ref.branchName }
      : { kind: ref.kind, repositoryFullName, prNumber: ref.prNumber }
  );
}

function sameEvent(
  left: SyncedMonitoredSessionActivityEvent,
  right: SyncedMonitoredSessionActivityEvent
): boolean {
  return (
    left.kind === right.kind &&
    left.occurredAt === right.occurredAt &&
    left.completeness === right.completeness
  );
}

function withoutCarrier(ref: MonitoredRef): SyncedArtifactRef {
  if (ref.monitoredSessionActivity === undefined) {
    return ref;
  }
  const { monitoredSessionActivity: _carrier, ...rest } = ref;
  return rest;
}

function compareMonitoredActivityPageItems(
  left: MonitoredActivityPageItem,
  right: MonitoredActivityPageItem
): number {
  return (
    Date.parse(right.event.occurredAt) - Date.parse(left.event.occurredAt) ||
    compareMonitoredActivityIdentities(left.targetKey, right.targetKey) ||
    compareMonitoredActivityIdentities(
      left.event.sourceEventId,
      right.event.sourceEventId
    )
  );
}

/**
 * ISS-9860: stamp every carrier on the chunks from `from` onward `Partial` — the shape a dropped tail
 * takes on the wire. When the chunk budget leaves part of the monitored stream
 * behind, the pages that DO ship must say so: the cloud re-stamps every event of
 * a `Partial` carrier, so the Branch reads it feeds report the evidence as
 * incomplete instead of presenting the shipped prefix as the whole set. Only
 * shrinks a chunk (`partial` is shorter than `complete`), so a measured page
 * stays within the cap.
 */
export function markMonitoredActivityPagesPartial(
  chunks: SyncedAgentSession[],
  from: number
): void {
  for (let index = from; index < chunks.length; index += 1) {
    const page = chunks[index];
    chunks[index] = {
      ...page,
      artifactRefs: page.artifactRefs?.map((ref) =>
        isMonitoredRef(ref) && ref.monitoredSessionActivity
          ? {
              ...ref,
              monitoredSessionActivity: {
                ...ref.monitoredSessionActivity,
                completeness: BranchActivityEvidenceCompleteness.Partial,
              },
            }
          : ref
      ),
    };
  }
}

/**
 * Pack `items` (already newest-first) into monitored pages of at most
 * {@link MONITORED_ACTIVITY_SYNC_PAGE_EVENTS} distinct events each, appending
 * every page that fits to `chunks`. Degradable: stops — keeping the pages
 * already built — when the chunk budget is exhausted or when even a
 * single-event page does not fit, and returns how many items shipped.
 *
 * Pages are SEALED BY MEASUREMENT, never by additive item math. A page adds a
 * carrier wrapper on every ref of each target it names and whole activity-only
 * envelopes the item JSON does not contain, while the item's own bytes
 * (`targetKey`, the event wrapper) never ship — so the running-total shortcut
 * the event streams use is neither exact nor an upper bound here, on the
 * identity sizer as much as on gzip. An over-cap page would dead-letter the
 * session on every re-prepare, so each candidate page is built and measured,
 * and halved until it fits.
 */
export function appendMonitoredActivityPages(
  chunks: SyncedAgentSession[],
  items: readonly MonitoredActivityPageItem[],
  buildPage: (page: MonitoredActivityPageItem[]) => SyncedAgentSession,
  fits: (chunk: SyncedAgentSession) => boolean,
  maxChunks: number
): number {
  let index = 0;
  while (index < items.length) {
    if (chunks.length + 1 > maxChunks) {
      return index;
    }
    let size = Math.min(
      MONITORED_ACTIVITY_SYNC_PAGE_EVENTS,
      items.length - index
    );
    for (;;) {
      const built = buildPage(items.slice(index, index + size));
      if (fits(built)) {
        chunks.push(built);
        index += size;
        break;
      }
      if (size === 1) {
        return index;
      }
      size = Math.ceil(size / 2);
    }
  }
  return index;
}
