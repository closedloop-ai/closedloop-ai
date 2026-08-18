/**
 * Shared real-Postgres fixtures for the desktop PR-sync integration suites
 * (FEA-2732 base sync + FEA-3917 cross-branch identity). Extracted so both
 * `agent-session-pull-request-sync.test.ts` and
 * `agent-session-pull-request-cross-branch.test.ts` reuse one seeding/sync
 * surface instead of duplicating it (AGENTS.md: shared test fixtures over copy).
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefRelation,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { withDb } from "@repo/database";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { generateSlug } from "@/lib/slug-generator";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

export const STARTED_AT = new Date("2026-07-10T10:00:00.000Z");
export const UPDATED_AT = new Date("2026-07-10T11:00:00.000Z");
export const PR_OBSERVED_AT = new Date("2026-07-10T10:30:00.000Z");
export const PR_MERGED_AT = new Date("2026-07-10T10:45:00.000Z");
export const PR_LATER_AT = new Date("2026-07-10T12:00:00.000Z");

export type PrSyncFixture = {
  organizationId: string;
  userId: string;
  projectId: string;
  computeTargetId: string;
  sourceArtifactId: string;
};

export function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "pr-sync-machine",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

/** A Document artifact in the project so the session attributes to a project. */
export async function createSourceArtifact(
  organizationId: string,
  projectId: string
) {
  const slug = await generateSlug(organizationId, SlugPrefix.Prd);
  return withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.Document,
        name: "Source PRD",
        slug,
        status: "DRAFT",
      },
      select: { id: true },
    })
  );
}

/** Seed an ACTIVE installation + one repo (App-installed repo). */
export async function seedRepo(organizationId: string, fullName: string) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `install-${suffix}`,
        accountId: `acct-${suffix}`,
        accountLogin: "org",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        status: "ACTIVE",
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: `fixture-${fullName}`,
              fullName,
            }),
            name: fullName.split("/")[1] ?? "repo",
            owner: fullName.split("/")[0] ?? "org",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repo = installation.repositories[0];
  if (!repo) {
    throw new Error("Failed to seed repository for test");
  }
  return { repositoryId: repo.id, fullName: repo.fullName };
}

/** Seed canonical public-repository authority without an App installation. */
export function seedPublicRepo(organizationId: string, fullName: string) {
  return withDb((db) =>
    db.publicRepository.upsert({
      where: {
        organizationId_githubRepoId: {
          organizationId,
          githubRepoId: `fixture-${fullName}`,
        },
      },
      create: {
        organizationId,
        owner: fullName.split("/")[0] ?? "org",
        name: fullName.split("/")[1] ?? "repo",
        htmlUrl: `https://github.com/${fullName}`,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `fixture-${fullName}`,
          fullName,
        }),
      },
      update: {},
    })
  );
}

export function pullRequestRef(
  overrides: Partial<Extract<SyncedArtifactRef, { kind: "pull_request" }>> & {
    repositoryFullName: string;
    prNumber: number;
    branchName: string;
  }
): SyncedArtifactRef {
  return {
    kind: "pull_request",
    method: "gh_pr_create",
    relation: ArtifactRefRelation.Created,
    observedAt: PR_OBSERVED_AT.toISOString(),
    ...overrides,
  };
}

export function branchRef(
  repositoryFullName: string,
  branchName: string
): SyncedArtifactRef {
  return {
    kind: "branch",
    repositoryFullName,
    branchName,
    method: "gh_pr_create",
    relation: ArtifactRefRelation.Created,
    observedAt: PR_OBSERVED_AT.toISOString(),
  };
}

export async function syncSession(input: {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  sourceArtifactId: string;
  externalSessionId?: string;
  artifactRefs: SyncedArtifactRef[];
}): Promise<void> {
  const repositoryFullNames = new Set(
    input.artifactRefs.flatMap((ref) =>
      "repositoryFullName" in ref ? [ref.repositoryFullName] : []
    )
  );
  for (const repositoryFullName of repositoryFullNames) {
    const installed = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          fullName: repositoryFullName,
          installation: {
            organizationId: input.organizationId,
            status: "ACTIVE",
          },
        },
        select: { id: true },
      })
    );
    if (!installed) {
      await seedPublicRepo(input.organizationId, repositoryFullName);
    }
  }
  const session: SyncedAgentSession = {
    externalSessionId: input.externalSessionId ?? "ext-pr-session",
    name: "PR sync session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-opus",
    startedAt: STARTED_AT.toISOString(),
    updatedAt: UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    attribution: { sourceArtifactId: input.sourceArtifactId },
    artifactRefs: input.artifactRefs,
  };
  await agentSessionsService.upsertSessions(
    {
      organizationId: input.organizationId,
      userId: input.userId,
      computeTargetId: input.computeTargetId,
    },
    {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: randomUUID(),
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
      sessions: [session],
    }
  );
}

export function findPrByBranchNumber(branchArtifactId: string, number: number) {
  return withDb((db) =>
    db.pullRequestDetail.findFirst({ where: { branchArtifactId, number } })
  );
}

export function findBranch(
  organizationId: string,
  repositoryFullName: string,
  branchName: string
) {
  return withDb((db) =>
    db.branchDetail.findFirst({
      where: { organizationId, repositoryFullName, branchName },
    })
  );
}

export async function baseFixture(): Promise<PrSyncFixture> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTarget = await createComputeTarget(organizationId, user.id);
  const source = await createSourceArtifact(organizationId, projectId);
  return {
    organizationId,
    userId: user.id,
    projectId,
    computeTargetId: computeTarget.id,
    sourceArtifactId: source.id,
  };
}
