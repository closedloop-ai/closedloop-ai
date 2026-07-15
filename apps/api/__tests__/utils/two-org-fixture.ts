import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { withDb } from "@repo/database";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { branchService } from "@/app/branches/branch-service";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "./db-helpers";

/**
 * FEA-2734 Phase 4 — the reusable two-org isolation fixture (PRD-510 D2/Q10).
 *
 * Seeds two organizations A and B whose rows share IDENTICAL natural keys: the
 * same normalized repo full name, branch name, and session external id. This is
 * the deliberately adversarial dedup-key case — the org tenancy boundary, not the
 * natural keys, must keep the tenants apart, so any cross-org leak surfaces as a
 * wrong-org row rather than as an error. Other PRD-510 lanes (PLN-1296/1297/1298)
 * reuse this fixture and extend it (e.g. commits/PRs) for their own suites.
 *
 * Call from inside `autoRollbackTransaction` — every write joins the ambient
 * rollback, so nothing persists.
 */

export const SHARED_REPO_FULL_NAME = "acme/app";
export const SHARED_BRANCH_NAME = "feature/shared";
export const SHARED_EXTERNAL_SESSION_ID = "shared-external-session";

const SESSION_STARTED_AT = "2026-06-10T10:00:00.000Z";
const SESSION_UPDATED_AT = "2026-06-10T11:00:00.000Z";

export type SeededOrg = {
  organizationId: string;
  userId: string;
  projectId: string;
  computeTargetId: string;
  repositoryId: string;
  branchArtifactId: string;
  sessionArtifactId: string;
};

export type TwoOrgFixture = {
  orgA: SeededOrg;
  orgB: SeededOrg;
};

async function seedRepo(
  organizationId: string,
  label: string
): Promise<string> {
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        // `installationId` is @unique; derive it per call so a second fixture
        // seed in one test can never collide (labels alone are not enough).
        installationId: randomUUID(),
        accountId: `acct-${label}`,
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: `sender-${label}`,
        repositories: {
          create: {
            githubRepoId: `repo-${label}`,
            fullName: SHARED_REPO_FULL_NAME,
            name: "app",
            owner: "acme",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repo = installation.repositories[0];
  if (!repo) {
    throw new Error("two-org-fixture: failed to seed repository");
  }
  return repo.id;
}

async function seedBranch(
  organizationId: string,
  repositoryId: string,
  projectId: string
): Promise<string> {
  const result = await branchService.upsertBranchArtifact({
    organizationId,
    repositoryId,
    repositoryFullName: SHARED_REPO_FULL_NAME,
    branchName: SHARED_BRANCH_NAME,
    projectId,
  });
  if (!result.ok) {
    throw new Error("two-org-fixture: failed to seed branch");
  }
  const branch = await withDb((db) =>
    db.branchDetail.findFirstOrThrow({
      where: {
        organizationId,
        repositoryFullName: normalizeRepoFullName(SHARED_REPO_FULL_NAME),
        branchName: SHARED_BRANCH_NAME,
      },
      select: { artifactId: true },
    })
  );
  // Stamp set-once push evidence so the branch is visible in the org-wide list
  // (branchRemoteEvidenceWhere requires firstPushedAt or a current PR).
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: branch.artifactId },
      data: {
        firstPushedAt: new Date(SESSION_STARTED_AT),
        pushSource: BranchPushSource.Session,
      },
    })
  );
  return branch.artifactId;
}

async function seedSession(
  context: {
    organizationId: string;
    userId: string;
    computeTargetId: string;
  },
  batchId: string
): Promise<string> {
  const session: SyncedAgentSession = {
    externalSessionId: SHARED_EXTERNAL_SESSION_ID,
    status: "active",
    harness: "codex",
    cwd: "/tmp/two-org-fixture",
    startedAt: SESSION_STARTED_AT,
    updatedAt: SESSION_UPDATED_AT,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    tokenEvents: [
      {
        externalEventId: "evt-1",
        model: "claude-opus-4",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        estimatedCostUsd: 0.5,
        createdAt: SESSION_STARTED_AT,
      },
    ],
  };
  const payload: DesktopAgentSessionsPayload = {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId,
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  };
  await agentSessionsService.upsertSessions(context, payload);
  const row = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: context.computeTargetId,
          externalSessionId: SHARED_EXTERNAL_SESSION_ID,
        },
      },
      select: { artifactId: true },
    })
  );
  return row.artifactId;
}

async function seedOneOrg(label: string, batchId: string): Promise<SeededOrg> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTarget = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `two-org-${label}`,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  const repositoryId = await seedRepo(organizationId, label);
  const branchArtifactId = await seedBranch(
    organizationId,
    repositoryId,
    projectId
  );
  const sessionArtifactId = await seedSession(
    {
      organizationId,
      userId: user.id,
      computeTargetId: computeTarget.id,
    },
    batchId
  );
  return {
    organizationId,
    userId: user.id,
    projectId,
    computeTargetId: computeTarget.id,
    repositoryId,
    branchArtifactId,
    sessionArtifactId,
  };
}

/**
 * Seed the two-org fixture. Org A and Org B are structurally identical and share
 * every natural key; only their `organizationId` differs.
 */
export async function seedTwoOrgFixture(): Promise<TwoOrgFixture> {
  const orgA = await seedOneOrg("a", "11111111-1111-4111-8111-111111111111");
  const orgB = await seedOneOrg("b", "22222222-2222-4222-8222-222222222222");
  return { orgA, orgB };
}
