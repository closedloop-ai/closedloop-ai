import type {
  AgentSessionLastSyncTarget,
  SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { AgentSessionUsageQuery } from "../validators";
import { isUuid, normalizeNullableString } from "./coercion";
import type {
  AgentSessionUpsertTx,
  LastSyncTargetRecord,
  SessionProjectResolution,
} from "./records";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: attribution resolution intentionally folds artifact, loop, and repository lookups into one coordinator
export async function resolveProjectResolution(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<SessionProjectResolution> {
  const artifactIds = new Set<string>();
  const loopIds = new Set<string>();
  const repositoryFullNames = new Set<string>();

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
    const repositoryFullName = normalizeNullableString(
      attribution.repositoryFullName
    );
    if (repositoryFullName) {
      repositoryFullNames.add(repositoryFullName);
    }
  }

  const [artifacts, loops, repositories] = await Promise.all([
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
    repositoryFullNames.size > 0
      ? tx.gitHubInstallationRepository.findMany({
          where: {
            fullName: {
              in: [...repositoryFullNames],
            },
            teamRepositories: {
              some: {
                team: {
                  is: {
                    organizationId,
                  },
                },
              },
            },
          },
          select: {
            fullName: true,
            teamRepositories: {
              select: {
                team: {
                  select: {
                    projects: {
                      select: {
                        projectId: true,
                      },
                    },
                  },
                },
              },
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

  const repoToProjectIds = new Map<string, Set<string>>();
  for (const repository of repositories) {
    const ids = repoToProjectIds.get(repository.fullName) ?? new Set<string>();
    for (const teamRepository of repository.teamRepositories) {
      for (const project of teamRepository.team.projects) {
        ids.add(project.projectId);
      }
    }
    repoToProjectIds.set(repository.fullName, ids);
  }

  const projectByRepositoryFullName = new Map<string, string | null>();
  for (const [fullName, projectIds] of repoToProjectIds) {
    projectByRepositoryFullName.set(
      fullName,
      projectIds.size === 1 ? [...projectIds][0] : null
    );
  }

  return {
    artifactProjectById,
    loopProjectById,
    projectByRepositoryFullName,
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

  const repositoryFullName = normalizeNullableString(
    attribution.repositoryFullName
  );
  if (!repositoryFullName) {
    return null;
  }
  return resolution.projectByRepositoryFullName.get(repositoryFullName) ?? null;
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
    owner: record.user,
  };
}
