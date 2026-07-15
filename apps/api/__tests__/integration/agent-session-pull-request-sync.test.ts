/**
 * Integration tests for desktop PR sync into PullRequestDetail (FEA-2732 /
 * PLN-1299). These run against a real Postgres because the feature's guarantees
 * are DB-level: producer-independent identity + convergence on one row,
 * webhook-wins conflict resolution, App-install adoption, two-org isolation, and
 * the derived session -> branch -> current-PR association. `upsertSessions`
 * ingests a session's `pull_request` artifactRef and writes the PR row nested
 * under its D2 head-branch artifact.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefRelation,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  adoptRepolessPullRequestByRepoIdentity,
  adoptRepolessPullRequestDetail,
} from "@/app/branches/github-projection-writer";
import { generateSlug } from "@/lib/slug-generator";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const STARTED_AT = new Date("2026-07-10T10:00:00.000Z");
const UPDATED_AT = new Date("2026-07-10T11:00:00.000Z");
const PR_OBSERVED_AT = new Date("2026-07-10T10:30:00.000Z");
const PR_MERGED_AT = new Date("2026-07-10T10:45:00.000Z");
const PR_LATER_AT = new Date("2026-07-10T12:00:00.000Z");

function createComputeTarget(organizationId: string, userId: string) {
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
async function createSourceArtifact(organizationId: string, projectId: string) {
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
async function seedRepo(organizationId: string, fullName: string) {
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
            githubRepoId: `repo-${suffix}`,
            fullName,
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

function pullRequestRef(
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

function branchRef(
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

async function syncSession(input: {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  sourceArtifactId: string;
  externalSessionId?: string;
  artifactRefs: SyncedArtifactRef[];
}): Promise<void> {
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

function findPrByBranchNumber(branchArtifactId: string, number: number) {
  return withDb((db) =>
    db.pullRequestDetail.findFirst({ where: { branchArtifactId, number } })
  );
}

function findBranch(
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

async function baseFixture() {
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

describeIfDb("desktop PR sync -> PullRequestDetail (FEA-2732)", () => {
  it("creates a repo-less PullRequestDetail nested under the D2 branch and sets it current (non-App, OPEN)", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const normalized = normalizeRepoFullName(repo);
      const branchName = "feature/pr-sync";

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 42,
            branchName,
            title: "Add PR sync",
            state: GitHubPRState.Open,
            additions: 120,
            deletions: 8,
            changedFiles: 5,
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalized,
        branchName
      );
      expect(branch).not.toBeNull();
      const pr = await findPrByBranchNumber(branch!.artifactId, 42);
      expect(pr).not.toBeNull();
      expect(pr?.repositoryId).toBeNull();
      expect(pr?.githubId).toBeNull();
      expect(pr?.organizationId).toBe(fx.organizationId);
      expect(pr?.repositoryFullName).toBe(normalized);
      // htmlUrl is derived server-side from the trusted repo + number, never
      // from a client-supplied URL (anti-forgery).
      expect(pr?.htmlUrl).toBe("https://github.com/acme/widgets/pull/42");
      expect(pr?.prState).toBe(GitHubPRState.Open);
      expect(pr?.additions).toBe(120);
      expect(pr?.deletions).toBe(8);
      expect(pr?.changedFiles).toBe(5);
      expect(pr?.isCurrent).toBe(true);
      expect(pr?.fetchMechanism).toBe(GitHubFetchMechanism.DesktopSync);
      expect(pr?.lastVerifiedAt).not.toBeNull();
      expect(branch?.currentPullRequestDetailId).toBe(pr?.id);

      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: branch!.artifactId },
          select: { status: true },
        })
      );
      expect(artifact?.status).toBe(GitHubPRState.Open);
    });
  });

  it("advances the branch lifecycle to MERGED and stamps session push evidence", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const branchName = "feature/merged";

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 7,
            branchName,
            state: GitHubPRState.Merged,
            mergedAt: PR_MERGED_AT.toISOString(),
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalizeRepoFullName(repo),
        branchName
      );
      const pr = await findPrByBranchNumber(branch!.artifactId, 7);
      expect(pr?.prState).toBe(GitHubPRState.Merged);
      expect(pr?.mergedAt?.toISOString()).toBe(PR_MERGED_AT.toISOString());
      expect(branch?.firstPushedAt).not.toBeNull();
      expect(branch?.pushSource).toBe("session");

      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: branch!.artifactId },
          select: { status: true },
        })
      );
      expect(artifact?.status).toBe(GitHubPRState.Merged);
    });
  });

  it("converges on a single row across idempotent re-sync, refreshing facts", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const branchName = "feature/idempotent";

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 11,
            branchName,
            state: GitHubPRState.Open,
            additions: 1,
          }),
        ],
      });
      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 11,
            branchName,
            state: GitHubPRState.Merged,
            additions: 42,
            mergedAt: PR_MERGED_AT.toISOString(),
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalizeRepoFullName(repo),
        branchName
      );
      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: { branchArtifactId: branch!.artifactId, number: 11 },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.prState).toBe(GitHubPRState.Merged);
      expect(rows[0]?.additions).toBe(42);
    });
  });

  it("isolates PRs with the same (repo, number) across organizations", async () => {
    await autoRollbackTransaction(async () => {
      const repo = "acme/widgets";
      const normalized = normalizeRepoFullName(repo);
      const branchName = "feature/shared-number";

      const fxA = await baseFixture();
      const fxB = await baseFixture();
      for (const fx of [fxA, fxB]) {
        await syncSession({
          ...fx,
          artifactRefs: [
            branchRef(repo, branchName),
            pullRequestRef({
              repositoryFullName: repo,
              prNumber: 99,
              branchName,
              state: GitHubPRState.Open,
            }),
          ],
        });
      }

      const branchA = await findBranch(
        fxA.organizationId,
        normalized,
        branchName
      );
      const branchB = await findBranch(
        fxB.organizationId,
        normalized,
        branchName
      );
      expect(branchA?.artifactId).not.toBe(branchB?.artifactId);
      const prA = await findPrByBranchNumber(branchA!.artifactId, 99);
      const prB = await findPrByBranchNumber(branchB!.artifactId, 99);
      expect(prA?.id).not.toBe(prB?.id);
      expect(prA?.organizationId).toBe(fxA.organizationId);
      expect(prB?.organizationId).toBe(fxB.organizationId);
    });
  });

  it("adopts a desktop repo-less row when the App installs later (no duplicate)", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const branchName = "feature/adopt";

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 5,
            branchName,
            state: GitHubPRState.Open,
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalizeRepoFullName(repo),
        branchName
      );
      const before = await findPrByBranchNumber(branch!.artifactId, 5);
      expect(before?.repositoryId).toBeNull();

      const seeded = await seedRepo(fx.organizationId, "acme/widgets");
      await withDb((db) =>
        adoptRepolessPullRequestDetail(db, {
          branchArtifactId: branch!.artifactId,
          number: 5,
          repositoryId: seeded.repositoryId,
          githubId: "PR_kwDO_adopt_5",
        })
      );

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: { branchArtifactId: branch!.artifactId, number: 5 },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(before?.id);
      expect(rows[0]?.repositoryId).toBe(seeded.repositoryId);
      expect(rows[0]?.githubId).toBe("PR_kwDO_adopt_5");
    });
  });

  it("adopts a desktop App-repo row (repositoryId set, githubId null) in place, stamping githubId (FEA-2732 HIGH #1)", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const branchName = "feature/app-repo-adopt";

      // The App is installed BEFORE the desktop sync, so the desktop row
      // resolves a real repositoryId while its githubId stays null (no webhook
      // has fired yet).
      const seeded = await seedRepo(fx.organizationId, repo);

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 9,
            branchName,
            state: GitHubPRState.Open,
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalizeRepoFullName(repo),
        branchName
      );
      const before = await findPrByBranchNumber(branch!.artifactId, 9);
      // HIGH #1 precondition: repositoryId already set, githubId still null.
      expect(before?.repositoryId).toBe(seeded.repositoryId);
      expect(before?.githubId).toBeNull();

      // Before the fix, adoption matched only repositoryId: null rows, so this
      // App-repo row was skipped and its githubId stayed null — the githubId-
      // keyed upsert then CREATE-collided (P2002) on repositoryId_number.
      await withDb((db) =>
        adoptRepolessPullRequestDetail(db, {
          branchArtifactId: branch!.artifactId,
          number: 9,
          repositoryId: seeded.repositoryId,
          githubId: "PR_kwDO_high1_9",
        })
      );

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: { branchArtifactId: branch!.artifactId, number: 9 },
        })
      );
      // Filled in place: one row (no duplicate), githubId now stamped.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(before?.id);
      expect(rows[0]?.repositoryId).toBe(seeded.repositoryId);
      expect(rows[0]?.githubId).toBe("PR_kwDO_high1_9");
    });
  });

  it("webhook-wins: desktop sync only gap-fills a webhook-owned row and does not advance status", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const normalized = normalizeRepoFullName(repo);
      const branchName = "feature/webhook-wins";
      const seeded = await seedRepo(fx.organizationId, repo);

      // A webhook-owned branch + current PR (CLOSED, additions unknown).
      const branchArtifact = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: fx.organizationId,
            projectId: fx.projectId,
            type: ArtifactType.Branch,
            name: branchName,
            status: GitHubPRState.Closed,
            branch: {
              create: {
                organizationId: fx.organizationId,
                repositoryId: seeded.repositoryId,
                repositoryFullName: normalized,
                branchName,
              },
            },
          },
          select: { id: true },
        })
      );
      const webhookPr = await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            branchArtifactId: branchArtifact.id,
            organizationId: fx.organizationId,
            repositoryId: seeded.repositoryId,
            repositoryFullName: normalized,
            githubId: "PR_webhook_3",
            number: 3,
            title: "Webhook title",
            prState: GitHubPRState.Closed,
            isCurrent: true,
            fetchCredentialType: GitHubFetchCredentialType.GitHubApp,
            fetchMechanism: GitHubFetchMechanism.Webhook,
            fetchTrigger: GitHubFetchTrigger.Webhook,
            fetchObservedAt: PR_OBSERVED_AT,
          },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: branchArtifact.id },
          data: { currentPullRequestDetailId: webhookPr.id },
        })
      );

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 3,
            branchName,
            title: "Desktop title",
            state: GitHubPRState.Open,
            additions: 17,
          }),
        ],
      });

      const pr = await findPrByBranchNumber(branchArtifact.id, 3);
      // Authoritative fields unchanged (webhook-wins); the null gap is filled.
      expect(pr?.title).toBe("Webhook title");
      expect(pr?.prState).toBe(GitHubPRState.Closed);
      expect(pr?.additions).toBe(17);
      expect(pr?.fetchMechanism).toBe(GitHubFetchMechanism.Webhook);

      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: branchArtifact.id },
          select: { status: true },
        })
      );
      // Branch status is not advanced back to OPEN by desktop state.
      expect(artifact?.status).toBe(GitHubPRState.Closed);
    });
  });

  it("skips an out-of-order (older) desktop sync so PR/branch state cannot regress", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const branchName = "feature/monotonic";

      // A newer observation establishes OPEN + additions 5.
      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 8,
            branchName,
            state: GitHubPRState.Open,
            additions: 5,
            observedAt: PR_LATER_AT.toISOString(),
          }),
        ],
      });
      // An OLDER observation carrying MERGED must be ignored as stale.
      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 8,
            branchName,
            state: GitHubPRState.Merged,
            additions: 99,
            observedAt: PR_OBSERVED_AT.toISOString(),
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalizeRepoFullName(repo),
        branchName
      );
      const pr = await findPrByBranchNumber(branch!.artifactId, 8);
      expect(pr?.prState).toBe(GitHubPRState.Open);
      expect(pr?.additions).toBe(5);
      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: branch!.artifactId },
          select: { status: true },
        })
      );
      expect(artifact?.status).toBe(GitHubPRState.Open);
    });
  });

  it("adopts a repo-less row + its branch by D2 identity when the App installs (webhook path)", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const normalized = normalizeRepoFullName(repo);
      const branchName = "feature/wh-adopt";

      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 12,
            branchName,
            state: GitHubPRState.Open,
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalized,
        branchName
      );
      expect(branch?.repositoryId).toBeNull();
      const before = await findPrByBranchNumber(branch!.artifactId, 12);
      expect(before?.repositoryId).toBeNull();

      const seeded = await seedRepo(fx.organizationId, repo);
      const adopted = await withDb((db) =>
        adoptRepolessPullRequestByRepoIdentity(db, {
          organizationId: fx.organizationId,
          repositoryFullName: normalized,
          number: 12,
          repositoryId: seeded.repositoryId,
          githubId: "PR_kwDO_wh_12",
        })
      );
      expect(adopted).toBe(true);

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: { branchArtifactId: branch!.artifactId, number: 12 },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(before?.id);
      expect(rows[0]?.repositoryId).toBe(seeded.repositoryId);
      expect(rows[0]?.githubId).toBe("PR_kwDO_wh_12");

      // The branch's repo identity is stamped too, so repo-scoped branch reads
      // (pr.repository_id = b.repository_id) stay consistent post-adoption.
      const adoptedBranch = await withDb((db) =>
        db.branchDetail.findUnique({
          where: { artifactId: branch!.artifactId },
          select: { repositoryId: true },
        })
      );
      expect(adoptedBranch?.repositoryId).toBe(seeded.repositoryId);

      // Idempotent: no repo-less row remains, so a re-run adopts nothing.
      const again = await withDb((db) =>
        adoptRepolessPullRequestByRepoIdentity(db, {
          organizationId: fx.organizationId,
          repositoryFullName: normalized,
          number: 12,
          repositoryId: seeded.repositoryId,
          githubId: "PR_kwDO_wh_12",
        })
      );
      expect(again).toBe(false);
    });
  });

  it("never downgrades a terminal MERGED branch status (desktop cannot un-merge)", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const repo = "acme/widgets";
      const branchName = "feature/no-downgrade";

      // Establish a MERGED branch from a desktop-owned PR.
      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 4,
            branchName,
            state: GitHubPRState.Merged,
            observedAt: PR_OBSERVED_AT.toISOString(),
          }),
        ],
      });
      // A LATER (non-stale) observation carrying OPEN passes the monotonic guard
      // and refreshes the PR row, but must NOT roll the terminal branch status
      // back to OPEN — mirrors the narrow desktop/webhook race.
      await syncSession({
        ...fx,
        artifactRefs: [
          branchRef(repo, branchName),
          pullRequestRef({
            repositoryFullName: repo,
            prNumber: 4,
            branchName,
            state: GitHubPRState.Open,
            observedAt: PR_LATER_AT.toISOString(),
          }),
        ],
      });

      const branch = await findBranch(
        fx.organizationId,
        normalizeRepoFullName(repo),
        branchName
      );
      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: branch!.artifactId },
          select: { status: true },
        })
      );
      expect(artifact?.status).toBe(GitHubPRState.Merged);
    });
  });
});
