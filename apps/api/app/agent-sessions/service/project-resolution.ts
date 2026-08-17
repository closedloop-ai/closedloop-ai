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
  const loopIds = new Set<string>();

  for (const session of sessions) {
    const attribution = session.attribution;
    if (!attribution) {
      continue;
    }
    if (isUuid(attribution.sourceArtifactId)) {
      artifactIds.add(attribution.sourceArtifactId);
    }
    if (isUuid(attribution.sourceLoopId)) {
      loopIds.add(attribution.sourceLoopId);
    }
  }

  const [artifacts, loops] = await Promise.all([
    artifactIds.size > 0
      ? tx.artifact.findMany({
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
      : Promise.resolve([]),
    loopIds.size > 0
      ? tx.loop.findMany({
          where: {
            organizationId,
            id: {
              in: [...loopIds],
            },
          },
          select: {
            id: true,
            artifactId: true,
            artifact: {
              select: { projectId: true },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const artifactProjectById = new Map<string, string>();
  for (const artifact of artifacts) {
    // artifact.projectId is nullable since SESSION artifacts can be unparented;
    // only project-attached source artifacts contribute a resolvable project.
    if (artifact.projectId) {
      artifactProjectById.set(artifact.id, artifact.projectId);
    }
  }

  // FEA-1718: every loop the query returned is, by that query's own predicate, a
  // real loop in THIS organization. Capture that membership before the
  // project-only narrowing below drops the ones without a project — those are
  // still valid loops, and promoting a session to `SessionOrigin.LOOP` must key
  // off loop EXISTENCE, not off whether the loop happens to have a project.
  const sameOrgLoopIds = new Set(loops.map((loop) => loop.id));

  const loopProjectById = new Map<string, string>();
  for (const loop of loops) {
    // Prefer the loop's directly-attached artifact projectId (the artifact
    // selected alongside the loop above). Fall back to the
    // artifactProjectById map populated from session.attribution.sourceArtifactId
    // — useful when the attribution-derived lookup covers an artifact the loop
    // also references but the loop's own artifact include returned null.
    const projectId =
      loop.artifact?.projectId ??
      (loop.artifactId ? artifactProjectById.get(loop.artifactId) : undefined);
    if (projectId) {
      loopProjectById.set(loop.id, projectId);
    }
  }

  return {
    artifactProjectById,
    loopProjectById,
    sameOrgLoopIds,
  };
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

  if (isUuid(attribution.sourceLoopId)) {
    const projectId = resolution.loopProjectById.get(attribution.sourceLoopId);
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
  // second. Only real lineage (sourceArtifactId / sourceLoopId) parents a
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
