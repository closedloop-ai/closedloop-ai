/**
 * Shared seeding/fixture harness for the branch-artifact integration suites.
 *
 * Extracted so `branch-artifact-flows.test.ts` (a shrink-only grandfathered
 * file under `noExcessiveLinesPerFile`) and its push-lifecycle sibling can share
 * one owner for the org/installation/repo/project seed, the push-event builder,
 * and the branch lookup — instead of drifting apart or growing the big file.
 *
 * `vi.hoisted` mock handles cannot cross module boundaries, so the per-file mock
 * wiring (authState, parseArtifactReferences) stays in each test file and is
 * applied through the `onSeeded` hook below.
 */

import type { PushEvent } from "@octokit/webhooks-types";
import {
  IssueStatus,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document";
import {
  ArtifactSubtype,
  ArtifactType,
  GitHubInstallationStatus,
  withDb,
} from "@repo/database";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

export type TestContext = {
  organizationId: string;
  userId: string;
  projectId: string;
  sourceArtifactId: string;
  repositoryId: string;
  repositoryFullName: string;
  githubRepoId: number;
  installationRecordId: string;
  installationId: string;
};

const NON_DIGITS = /\D/g;

/**
 * Seed the org + GitHub installation + repository + project + source feature
 * document the branch-artifact suites assert against.
 *
 * @param onSeeded applied after seeding, for per-file `vi.hoisted` mock wiring
 * that cannot be imported across module boundaries.
 */
export async function seedBranchTestContext(
  onSeeded?: (context: TestContext) => void
): Promise<TestContext> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const githubRepoId = Math.floor(Math.random() * 1_000_000_000);
  const suffix = organizationId.replaceAll("-", "").slice(0, 8);
  const repositoryFullName = `owner/repo-${suffix}`;
  const installationId = `100000${githubRepoId}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId,
        accountId: `acct-${suffix}`,
        accountLogin: "owner",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: String(githubRepoId),
              fullName: repositoryFullName,
            }),
            name: `repo-${suffix}`,
            owner: "owner",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repository = installation.repositories[0];
  if (!repository) {
    throw new Error("Failed to seed repository");
  }

  const projectId = await createTestProject(organizationId, user.id);

  // Single-team inheritance is the supported way a project resolves its
  // primary repository (FEA-1058 removed the legacy project-settings repo
  // pointer). Curate the seeded repo as the team's primary and attach the
  // project to that team so `loadProjectRepoDefaults` /
  // `loadProjectPrLinkRepositories` resolve it.
  await withDb((db) =>
    db.team.create({
      data: {
        organizationId,
        name: `Team ${suffix}`,
        slug: `team-${suffix}`,
        repositories: {
          create: {
            installationRepositoryId: repository.id,
            isDefaultSelected: true,
            isPrimary: true,
          },
        },
        projects: {
          create: { projectId },
        },
      },
    })
  );

  const sourceArtifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        name: "FEA-1116 integration fixture",
        slug: "FEA-1116",
        // This artifact is a FEATURE subtype, so its status comes from the
        // IssueStatus vocabulary — `Artifact.status` is one freeform column
        // carrying several disjoint vocabularies (PRD-495), which is how the
        // document-side "APPROVED" ended up here before extraction.
        status: IssueStatus.Done,
        assigneeId: user.id,
        createdById: user.id,
        document: {
          create: {
            repositorySnapshot: {
              repositories: [
                {
                  fullName: repository.fullName,
                  role: RepositoryRole.Primary,
                  position: 0,
                  branch: "main",
                },
              ],
              source: SnapshotSource.ProjectDefaults,
            },
            versions: {
              create: {
                version: 1,
                content: "Branch artifact integration fixture",
                createdById: user.id,
              },
            },
          },
        },
      },
      select: { id: true },
    })
  );

  const context: TestContext = {
    organizationId,
    userId: user.id,
    projectId,
    sourceArtifactId: sourceArtifact.id,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    githubRepoId,
    installationRecordId: installation.id,
    installationId: installation.installationId,
  };
  onSeeded?.(context);
  return context;
}

export function pushEvent(
  ctx: TestContext,
  input: {
    branchName: string;
    before: string;
    after: string;
    created?: boolean;
    deleted?: boolean;
    pushedAt?: string;
  }
): PushEvent {
  return {
    ref: `refs/heads/${input.branchName}`,
    before: input.before,
    after: input.after,
    repository: {
      id: ctx.githubRepoId,
      name: ctx.repositoryFullName.split("/")[1],
      full_name: ctx.repositoryFullName,
      owner: { login: ctx.repositoryFullName.split("/")[0] },
      private: false,
      default_branch: "main",
      pushed_at: input.pushedAt ?? "2026-05-15T00:00:00Z",
    },
    commits: [
      {
        id: input.after,
        message: "Update branch",
        timestamp: "2026-05-15T00:00:00Z",
        added: [],
        removed: [],
        modified: [],
      },
    ],
    installation: {
      id: Number(ctx.installationId.replace(NON_DIGITS, "") || 1),
    },
    created: input.created ?? false,
    deleted: input.deleted ?? false,
  } as unknown as PushEvent;
}

export async function findBranchArtifact(
  repositoryId: string,
  branchName: string
) {
  const branch = await withDb((db) =>
    db.branchDetail.findFirst({
      where: {
        repositoryId,
        branchName,
      },
      include: {
        artifact: true,
        currentPullRequestDetail: true,
      },
    })
  );
  if (!branch) {
    throw new Error(`Branch artifact not found for ${branchName}`);
  }
  return branch;
}
