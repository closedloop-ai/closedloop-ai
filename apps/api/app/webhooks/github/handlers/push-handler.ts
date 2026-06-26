import type { PushEvent } from "@octokit/webhooks-types";
import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  getProjectSettings,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
import { Status } from "@repo/api/src/types/result";
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { branchService } from "@/app/branches/branch-service";
import { refreshBranchFileChangeCache } from "@/app/branches/file-cache-service";
import { pickPrimaryArtifactReference } from "./artifact-reference";

const HEAD_REF_PREFIX = "refs/heads/";

/**
 * Handle GitHub push webhook events.
 *
 * Updates lastPushedAt timestamp for the repository and logs push metadata.
 * Silently skips if no matching installation repository found.
 *
 * Security: Scopes updates to the specific installation to prevent updating
 * repositories across multiple installations with the same githubRepoId.
 */
export async function handlePush(event: PushEvent): Promise<Response> {
  const { ref, repository, before, after, commits, installation, deleted } =
    event;

  const installationId = installation?.id;
  const branchName = parseBranchName(ref);

  log.info("[handlePush] Processing push event", {
    repositoryFullName: repository.full_name,
    githubRepoId: repository.id,
    installationId,
    ref,
    commitsCount: commits.length,
    beforeSha: before,
    afterSha: after,
  });

  if (!branchName) {
    log.info("[handlePush] Skipping non-branch ref", { ref });
    return NextResponse.json({
      message: "Ignoring non-branch push ref",
      ok: true,
    });
  }

  const repositoryRow = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        githubRepoId: String(repository.id),
        fullName: repository.full_name,
        installation: {
          ...(installationId ? { installationId: String(installationId) } : {}),
          status: GitHubInstallationStatus.ACTIVE,
          organizationId: { not: null },
        },
      },
      select: {
        id: true,
        fullName: true,
        installation: { select: { organizationId: true } },
      },
    })
  );

  if (!repositoryRow?.installation.organizationId) {
    log.debug("[handlePush] Repository not found in database, skipping", {
      githubRepoId: repository.id,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: "Repository not tracked, ignoring push event",
      ok: true,
    });
  }

  const lastPushedAt = repository.pushed_at
    ? new Date(
        typeof repository.pushed_at === "number"
          ? repository.pushed_at * 1000
          : repository.pushed_at
      )
    : new Date();

  await withDb((db) =>
    db.gitHubInstallationRepository.updateMany({
      where: { id: repositoryRow.id },
      data: { lastPushedAt },
    })
  );

  if (branchName === repository.default_branch) {
    log.info("[handlePush] Skipping default branch push", {
      branchName,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: "Default branch push ignored",
      ok: true,
    });
  }

  const source = await resolvePushSourceArtifact({
    organizationId: repositoryRow.installation.organizationId,
    repositoryId: repositoryRow.id,
    branchName,
  });
  if (source.kind === "skipped") {
    log.info("[handlePush] No-slug branch ownership skipped", {
      branchName,
      repositoryFullName: repository.full_name,
      reason: source.reason,
      candidateProjectIds: source.candidateProjectIds,
    });
    return NextResponse.json({
      message: "No deterministic project repository default for branch push",
      ok: true,
    });
  }

  const result = await branchService.upsertBranchArtifact({
    organizationId: repositoryRow.installation.organizationId,
    repositoryId: repositoryRow.id,
    repositoryFullName: repositoryRow.fullName,
    branchName,
    defaultBranch: repository.default_branch,
    projectId: source.projectId,
    sourceArtifactId: source.sourceArtifactId,
    baseBranch: repository.default_branch,
    baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
    headSha: deleted ? null : after,
    headShaSource: deleted ? null : BranchHeadShaSource.PushWebhook,
    headShaObservedAt: new Date(),
    beforeSha: before,
    isDelete: deleted,
    deletedAt: deleted ? new Date() : null,
  });

  if (!result.ok) {
    const message =
      result.error === Status.Conflict
        ? "Stale branch push ignored"
        : "Branch push rejected";
    log.info("[handlePush] Branch materialization skipped", {
      branchName,
      repositoryFullName: repository.full_name,
      status: result.error,
    });
    return NextResponse.json({ message, ok: true });
  }

  if (!deleted) {
    waitUntil(
      refreshBranchFileChangeCache(result.value.id, {
        organizationId: repositoryRow.installation.organizationId,
      }).then((refreshResult) => {
        if (!refreshResult.ok) {
          log.warn("[handlePush] Branch file-cache refresh did not complete", {
            branchArtifactId: result.value.id,
            status: refreshResult.error,
          });
        }
      })
    );
  }

  log.info("[handlePush] Materialized branch artifact from push", {
    branchArtifactId: result.value.id,
    branchName,
    githubRepoId: repository.id,
  });

  return NextResponse.json({
    message: "Push event processed successfully",
    ok: true,
  });
}

function parseBranchName(ref: string): string | null {
  return ref.startsWith(HEAD_REF_PREFIX)
    ? ref.slice(HEAD_REF_PREFIX.length)
    : null;
}

type PushSourceResolution = {
  kind: "resolved";
  sourceArtifactId: string | null;
  projectId: string | null;
};

type PushSourceSkip = {
  kind: "skipped";
  reason: "ambiguous_project_default" | "missing_project_default";
  candidateProjectIds: string[];
};

type ProjectWithRepositoryDefaults = {
  id: string;
  settings: unknown;
  teams: Array<{
    team: {
      repositories: Array<{
        installationRepositoryId: string;
        isDefaultSelected: boolean;
        isPrimary: boolean;
      }>;
    };
  }>;
};

async function resolvePushSourceArtifact({
  organizationId,
  repositoryId,
  branchName,
}: {
  organizationId: string;
  repositoryId: string;
  branchName: string;
}): Promise<PushSourceResolution | PushSourceSkip> {
  const primaryRef = pickPrimaryArtifactReference(
    parseArtifactReferences(branchName, "", process.env.NEXT_PUBLIC_APP_URL)
  );

  if (primaryRef) {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          organizationId,
          slug: primaryRef.slug,
          type: ArtifactType.DOCUMENT,
          subtype: primaryRef.docType,
        },
        select: { id: true, projectId: true },
      })
    );
    if (artifact) {
      return {
        kind: "resolved",
        sourceArtifactId: artifact.id,
        projectId: artifact.projectId,
      };
    }
  }

  const existingBranch = await withDb((db) =>
    db.branchDetail.findUnique({
      where: {
        repositoryId_branchName: {
          repositoryId,
          branchName,
        },
      },
      select: {
        artifact: {
          select: {
            organizationId: true,
            projectId: true,
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: ArtifactType.DOCUMENT },
              },
              select: { source: { select: { id: true } } },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    })
  );
  if (!existingBranch) {
    return resolveFirstObservedNoSlugBranchOwnership({
      organizationId,
      repositoryId,
    });
  }
  if (existingBranch.artifact.organizationId !== organizationId) {
    return {
      kind: "skipped",
      reason: "missing_project_default",
      candidateProjectIds: [],
    };
  }
  const linkedSource = existingBranch.artifact.targetLinks[0]?.source ?? null;
  return {
    kind: "resolved",
    sourceArtifactId: linkedSource?.id ?? null,
    projectId: existingBranch.artifact.projectId,
  };
}

async function resolveFirstObservedNoSlugBranchOwnership({
  organizationId,
  repositoryId,
}: {
  organizationId: string;
  repositoryId: string;
}): Promise<PushSourceResolution | PushSourceSkip> {
  const projects = await withDb((db) =>
    db.project.findMany({
      where: {
        organizationId,
        isTemplatesSentinel: false,
      },
      select: {
        id: true,
        settings: true,
        teams: {
          select: {
            team: {
              select: {
                repositories: {
                  select: {
                    installationRepositoryId: true,
                    isDefaultSelected: true,
                    isPrimary: true,
                  },
                },
              },
            },
          },
        },
      },
    })
  );

  const candidates = projects.filter((project) =>
    projectDefaultContainsRepository(project, repositoryId)
  );
  if (candidates.length === 1) {
    return {
      kind: "resolved",
      sourceArtifactId: null,
      projectId: candidates[0].id,
    };
  }

  return {
    kind: "skipped",
    reason:
      candidates.length > 1
        ? "ambiguous_project_default"
        : "missing_project_default",
    candidateProjectIds: candidates.map((project) => project.id).sort(),
  };
}

function projectDefaultContainsRepository(
  project: ProjectWithRepositoryDefaults,
  repositoryId: string
): boolean {
  const settings = getProjectSettings((project.settings ?? {}) as JsonObject);
  const teamRepos = project.teams.flatMap((projectTeam) =>
    projectTeam.team.repositories.map((repo) => ({
      installationRepositoryId: repo.installationRepositoryId,
      isDefaultSelected: repo.isDefaultSelected,
      isPrimary: repo.isPrimary,
    }))
  );

  const resolved = resolveProjectRepoDefaults({
    projectSettings: settings,
    teamRepos,
    teamCount: project.teams.length,
  });
  return resolved?.selectedRepoIds.includes(repositoryId) ?? false;
}
