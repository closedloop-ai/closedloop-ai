import type { Priority } from "@repo/api/src/types/common";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

/**
 * ISS-10332: the priorities one sent session carried — its own and its branch
 * refs' — read off the payload that went on the wire, so the ack settles
 * exactly the values the cloud was shown (`priority-upload-marker.ts`).
 */
export type PriorityUploadClaim = {
  sessionId: string;
  priority?: Priority;
  branches: PriorityUploadBranchClaim[];
};

export type PriorityUploadBranchClaim = {
  repositoryFullName: string;
  branchName: string;
  priority: Priority;
};

/** The claims these wire sessions make; a session that makes none is absent. */
export function priorityUploadClaims(
  sessions: readonly SyncedAgentSession[]
): PriorityUploadClaim[] {
  const claims: PriorityUploadClaim[] = [];
  for (const session of sessions) {
    const branches: PriorityUploadBranchClaim[] = [];
    for (const ref of session.artifactRefs ?? []) {
      if (ref.kind === ArtifactRefTargetKind.Branch && ref.priority) {
        branches.push({
          repositoryFullName: ref.repositoryFullName,
          branchName: ref.branchName,
          priority: ref.priority,
        });
      }
    }
    if (session.priority || branches.length > 0) {
      claims.push({
        sessionId: session.externalSessionId,
        ...(session.priority ? { priority: session.priority } : {}),
        branches,
      });
    }
  }
  return claims;
}
