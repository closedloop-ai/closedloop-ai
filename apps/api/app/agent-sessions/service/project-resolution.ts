import type {
  AgentSessionLastSyncTarget,
  SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { AgentSessionUsageQuery } from "../validators";
import { isUuid } from "./coercion";
import type {
  AgentSessionUpsertTx,
  LastSyncTargetRecord,
  SessionProjectResolution,
} from "./records";

export async function resolveProjectResolution(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<SessionProjectResolution> {
  const artifactIds = new Set<string>();

  for (const session of sessions) {
    const sourceArtifactId = session.attribution?.sourceArtifactId;
    if (isUuid(sourceArtifactId)) {
      artifactIds.add(sourceArtifactId);
    }
  }

  const artifacts =
    artifactIds.size > 0
      ? await tx.artifact.findMany({
          where: {
            organizationId,
            id: {
              in: [...artifactIds],
            },
          },
          select: {
            id: true,
            projectId: true,
          },
        })
      : [];

  const artifactProjectById = new Map<string, string>();
  for (const artifact of artifacts) {
    // artifact.projectId is nullable since SESSION artifacts can be unparented;
    // only project-attached source artifacts contribute a resolvable project.
    if (artifact.projectId) {
      artifactProjectById.set(artifact.id, artifact.projectId);
    }
  }

  return { artifactProjectById };
}

export function resolveProjectId(
  session: SyncedAgentSession,
  resolution: SessionProjectResolution
): string | null {
  const attribution = session.attribution;
  if (!attribution) {
    return null;
  }

  if (isUuid(attribution.sourceArtifactId)) {
    const projectId = resolution.artifactProjectById.get(
      attribution.sourceArtifactId
    );
    if (projectId) {
      return projectId;
    }
  }

  // FEA-1749: there is deliberately NO repository -> project fallback here.
  // A project may nominate default repositories for agentic execution, but that
  // does not make a repository belong to a project — the relation does not exist
  // in the domain. The removed fallback inferred one anyway whenever a team
  // happened to have exactly one project, silently attributing ad-hoc local work
  // to an arbitrary project and re-attributing it the moment someone added a
  // second. Only real lineage (sourceArtifactId) parents a
  // session; everything else is honestly unparented.
  return null;
}

export function toViewerScope(
  filters?: Pick<AgentSessionUsageQuery, "viewerScope" | "teamId">
): AgentSessionViewerScope {
  if (
    filters?.viewerScope === AgentSessionViewerScope.Team ||
    filters?.teamId
  ) {
    return AgentSessionViewerScope.Team;
  }
  if (filters?.viewerScope === AgentSessionViewerScope.Self) {
    return AgentSessionViewerScope.Self;
  }
  return AgentSessionViewerScope.Organization;
}

export function toLastSyncTarget(
  record: LastSyncTargetRecord
): AgentSessionLastSyncTarget {
  return {
    computeTargetId: record.id,
    machineName: record.machineName,
    isOnline: record.isOnline,
    lastSeenAt: record.lastSeenAt,
    lastAgentSessionSyncAt: record.lastAgentSessionSyncAt,
    lastAgentSessionSyncAttemptAt: record.lastAgentSessionSyncAttemptAt,
    owner: record.user,
  };
}
