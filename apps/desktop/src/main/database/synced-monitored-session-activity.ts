import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  type SyncedArtifactRef,
  syncedArtifactRefSchema,
} from "@repo/api/src/types/session-artifact-link";
import { normalizeSyncedMonitoredSessionActivity } from "@repo/api/src/types/session-monitored-activity";
import { z } from "zod";
import type { SyncJsonObject } from "../agent-sync/agent-session-sync-contract.js";
import { parseJsonObjectText } from "../agent-sync/agent-sync-json-text.js";

export const MONITORED_ACTIVITY_ONLY_METADATA_KEY =
  "__monitoredSessionActivityRefs" as const;

type LocalArtifactRef = {
  targetKind: string;
  relation: string;
  method: string;
  evidence: string;
  observedAt: string;
  repoFullName?: string;
  branchName?: string;
  prNumber?: number;
  monitoredActivityOnly?: true;
};

const monitoredActivityOnlyRefsSchema = z
  .array(syncedArtifactRefSchema)
  .max(MAX_SYNCED_ARTIFACT_REFS_PRODUCER);

/** Project the optional carrier from locally retained link evidence. */
export function monitoredSessionActivityFromEvidence(
  evidenceText: string | null
) {
  const evidence = parseJsonObjectText(evidenceText);
  return normalizeSyncedMonitoredSessionActivity(
    evidence?.monitoredSessionActivity
  );
}

/** Build the private metadata field that retains transport-only activity refs. */
export function monitoredActivityOnlyMetadata(
  refs: readonly LocalArtifactRef[]
): SyncJsonObject {
  const activityOnlyRefs = refs.flatMap(toMonitoredActivityOnlyRef);
  if (activityOnlyRefs.length === 0) {
    return {};
  }
  return (
    parseJsonObjectText(
      JSON.stringify({
        [MONITORED_ACTIVITY_ONLY_METADATA_KEY]: activityOnlyRefs,
      })
    ) ?? {}
  );
}

/** Read validated transport-only refs from private persisted Session metadata. */
export function monitoredActivityOnlyRefsFromMetadata(
  metadata: SyncJsonObject | null
): SyncedArtifactRef[] {
  const parsed = monitoredActivityOnlyRefsSchema.safeParse(
    metadata?.[MONITORED_ACTIVITY_ONLY_METADATA_KEY]
  );
  return parsed.success
    ? parsed.data.filter(
        (ref) =>
          (ref.kind === ArtifactRefTargetKind.Branch ||
            ref.kind === ArtifactRefTargetKind.PullRequest) &&
          ref.monitoredActivityOnly === true &&
          ref.monitoredSessionActivity !== undefined
      )
    : [];
}

/** Remove the Desktop-private carrier store from the public Session metadata. */
export function withoutMonitoredActivityOnlyMetadata(
  metadata: SyncJsonObject | null
): SyncJsonObject | null {
  if (!metadata) {
    return null;
  }
  const publicMetadata = { ...metadata };
  Reflect.deleteProperty(publicMetadata, MONITORED_ACTIVITY_ONLY_METADATA_KEY);
  return publicMetadata;
}

/** Mark every retained carrier partial when the parent ref budget truncates. */
export function downgradeMonitoredSessionActivity(
  ref: SyncedArtifactRef
): SyncedArtifactRef {
  if (!("monitoredSessionActivity" in ref && ref.monitoredSessionActivity)) {
    return ref;
  }
  return {
    ...ref,
    monitoredSessionActivity: {
      ...ref.monitoredSessionActivity,
      completeness: BranchActivityEvidenceCompleteness.Partial,
      events: ref.monitoredSessionActivity.events.map((event) => ({
        ...event,
        completeness: BranchActivityEvidenceCompleteness.Partial,
      })),
    },
  };
}

function toMonitoredActivityOnlyRef(
  ref: LocalArtifactRef
): SyncedArtifactRef[] {
  if (!ref.monitoredActivityOnly) {
    return [];
  }
  const monitoredSessionActivity = monitoredSessionActivityFromEvidence(
    ref.evidence
  );
  if (!monitoredSessionActivity) {
    return [];
  }
  let candidate: unknown;
  if (
    ref.targetKind === ArtifactRefTargetKind.Branch &&
    ref.repoFullName &&
    ref.branchName
  ) {
    candidate = {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: ref.repoFullName,
      branchName: ref.branchName,
      method: ref.method,
      relation: ref.relation,
      observedAt: ref.observedAt,
      monitoredSessionActivity,
      monitoredActivityOnly: true as const,
    };
  } else if (
    ref.targetKind === ArtifactRefTargetKind.PullRequest &&
    ref.repoFullName &&
    ref.prNumber !== undefined
  ) {
    candidate = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: ref.repoFullName,
      prNumber: ref.prNumber,
      method: ref.method,
      relation: ref.relation,
      observedAt: ref.observedAt,
      ...(ref.branchName ? { branchName: ref.branchName } : {}),
      monitoredSessionActivity,
      monitoredActivityOnly: true as const,
    };
  }
  const parsed = syncedArtifactRefSchema.safeParse(candidate);
  return parsed.success ? [parsed.data] : [];
}
