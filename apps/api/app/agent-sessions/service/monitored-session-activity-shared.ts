import { createHash } from "node:crypto";
import {
  type MonitoredActivityTarget,
  monitoredActivityTargetKey,
} from "@repo/api/src/types/monitored-activity-target";
import {
  ArtifactRefTargetKind,
  isValidPullRequestNumber,
} from "@repo/api/src/types/session-artifact-link";
import type { SyncedMonitoredSessionActivityEvent } from "@repo/api/src/types/session-monitored-activity";

export type MonitoredActivityCandidate = {
  target: MonitoredActivityTarget;
  event: SyncedMonitoredSessionActivityEvent;
  transportOnly: boolean;
};

export type ResolvedActivityTarget = {
  branchArtifactId: string;
  pullRequestDetailId: string | null;
};

/** Deduplicate and order monitored targets with the same canonical key. */
export function uniqueMonitoredActivityTargets<
  T extends MonitoredActivityTarget,
>(targets: readonly T[]): T[] {
  return [
    ...new Map(
      targets.map((target) => [monitoredActivityTargetKey(target), target])
    ).values(),
  ].sort((left, right) =>
    monitoredActivityTargetKey(left).localeCompare(
      monitoredActivityTargetKey(right)
    )
  );
}

/** True when a monitored target can safely enter DB-backed identity lookups. */
export function isValidMonitoredActivityTarget(
  target: MonitoredActivityTarget
): boolean {
  return (
    target.kind === ArtifactRefTargetKind.Branch ||
    isValidPullRequestNumber(target.prNumber)
  );
}

/** Hash bounded monitored identities without persisting raw carrier values. */
export function monitoredActivityDigest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function monitoredActivitySourceEventId(
  prefix: string,
  ...parts: string[]
): string {
  return `${prefix}:${monitoredActivityDigest(...parts)}`;
}

/**
 * One candidate's identity within a delivery: the target it names plus the
 * source event on it. `collectCandidates` already deduplicates on that pair, so
 * it is unique per candidate and is what every per-candidate ledger keys on.
 */
export function monitoredActivityCandidateIdentity(
  candidate: MonitoredActivityCandidate
): string {
  return `${monitoredActivityTargetKey(candidate.target)}\u0000${candidate.event.sourceEventId}`;
}
