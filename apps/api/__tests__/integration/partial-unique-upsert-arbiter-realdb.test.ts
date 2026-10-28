// biome-ignore-all lint/suspicious/noMisplacedAssertion: Integration helpers assert from callbacks invoked by tests.
/**
 * PLN-1838 Step 3 (ISS-8267 same-shape audit): empirical arbiter probes for the
 * remaining Prisma native upserts on models that carry a partial unique index.
 *
 * ISS-8267's failure shape: with `previewFeatures = ["partialIndexes"]`, Prisma
 * 7.8 can pick a PARTIAL unique's columns as the `ON CONFLICT` arbiter instead
 * of the total unique named in `where`, and Postgres rejects a bare-column
 * arbiter whose only unique is partial with 42P10 — on every call, at SQL
 * generation time. The schema alone does not predict the arbiter, so each
 * remaining upsert call site is probed here against a REAL migrated Postgres
 * through its production entry point. A 42P10 from any probe means that call
 * site must stop using native upsert (see packages/database/AGENTS.md).
 *
 * Probed sites (every SANCTIONED_STATEMENTS entry in the no-partial-unique-upsert
 * source gate is backed by a case here):
 *   - SourceOccurrence  via recordDefinitionSourceOccurrence (definition-registry)
 *   - ComputeTarget     via computeTargetsService.register (gateway path)
 *   - PullRequestDetail via writeExistingBranchPullRequestProjection
 *     (where repositoryId_number) and the branch-service statement shape
 *     (where githubId)
 *   - GitHubCommentThreadProjection + GitHubCommentProjection via
 *     upsertGitHubIssueCommentThread
 *
 * This lane is advisory in CI (api-integration-tests is `continue-on-error`).
 * The Prisma range these probes last ran against is pinned by the BLOCKING
 * `scripts/lint/partial-unique-upsert-prisma-version-contract.test.ts`; when a
 * Prisma bump reds that pin, re-run this suite and advance it.
 *
 * Self-skips when DATABASE_URL is unset, like the sibling suites here. Run
 * explicitly:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/partial-unique-upsert-arbiter-realdb.test.ts \
 *     --config vitest.config.integration.mts
 *
 * Everything is namespaced under one tracked org and dropped in afterAll.
 */
import { randomUUID } from "node:crypto";
import {
  GitHubInstallationStatus,
  GitHubPRState,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeExistingBranchPullRequestProjection } from "@/app/branches/github-projection-writer";
import { upsertGitHubIssueCommentThread } from "@/app/comments/service/github/github-projection";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  ensureDefinitionVersion,
  recordDefinitionSourceOccurrence,
} from "@/app/definition-registry/service";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

type BranchFixture = {
  repositoryId: string;
  repositoryFullName: string;
  branchArtifactId: string;
};

/** One installation per org (organizationId is unique on GitHubInstallation). */
let cachedInstallationId: string | null = null;

async function installationIdFor(organizationId: string): Promise<string> {
  if (cachedInstallationId) {
    return cachedInstallationId;
  }
  const suffix = randomUUID().slice(0, 8);
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `probe-install-${suffix}`,
        accountId: `probe-account-${suffix}`,
        accountLogin: "probe-org",
        accountType: "Organization",
        senderLogin: "probe-sender",
        senderId: `probe-sender-${suffix}`,
        status: GitHubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    })
  );
  cachedInstallationId = installation.id;
  return installation.id;
}

/** Repository → branch artifact, namespaced per probe. */
async function seedBranchFixture(
  organizationId: string,
  userId: string
): Promise<BranchFixture> {
  const projectId = await createTestProject(organizationId, userId);
  const suffix = randomUUID().slice(0, 8);
  const repositoryFullName = `probe-org/probe-repo-${suffix}`;
  const installationRecordId = await installationIdFor(organizationId);
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.create({
      data: {
        installationId: installationRecordId,
        githubRepoId: `probe-repo-${suffix}`,
        fullName: repositoryFullName,
        name: `probe-repo-${suffix}`,
        owner: "probe-org",
        private: false,
      },
      select: { id: true },
    })
  );
  const branchArtifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: "BRANCH",
        name: `probe-branch-${suffix}`,
        status: GitHubPRState.OPEN,
        externalUrl: `https://github.com/${repositoryFullName}/tree/probe-branch-${suffix}`,
        branch: {
          create: {
            organizationId,
            repositoryFullName,
            repositoryId: repository.id,
            branchName: `probe-branch-${suffix}`,
            baseBranch: "main",
          },
        },
      },
      select: { id: true },
    })
  );
  return {
    repositoryId: repository.id,
    repositoryFullName,
    branchArtifactId: branchArtifact.id,
  };
}

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)(
  "partial-unique upsert arbiter probes (realdb)",
  () => {
    const orgs = createCommittedTestOrganizationTracker();
    let organizationId = "";
    let userId = "";

    beforeAll(async () => {
      organizationId = await orgs.create();
      const user = await createTestUser(organizationId);
      userId = user.id;
    });

    afterAll(async () => {
      await orgs.cleanup();
    });

    it("SourceOccurrence: device-target occurrence upsert arbitrates on the total 8-column key, idempotently", async () => {
      const registered = await computeTargetsService.register(
        organizationId,
        userId,
        {
          machineName: `probe-occurrence-${randomUUID().slice(0, 8)}`,
          platform: "darwin",
          supportedOperations: [],
        }
      );
      if (!registered.ok) {
        throw new Error(`compute-target seed failed: ${registered.error}`);
      }
      const computeTargetId = registered.value.id;

      const record = (now: Date) =>
        withDb.tx(async (tx) => {
          const definitionVersionId = await ensureDefinitionVersion(tx, {
            organizationId,
            componentKind: "skill",
            content: "# probe definition (PLN-1838 Step 3)",
            observedAt: now,
          });
          const occurrenceId = await recordDefinitionSourceOccurrence(tx, {
            organizationId,
            definitionVersionId,
            computeTargetId,
            installPath: "/home/probe/.claude/skills/probe.md",
          });
          return { definitionVersionId, occurrenceId };
        });

      const first = await record(new Date());
      const second = await record(new Date());

      expect(second.definitionVersionId).toBe(first.definitionVersionId);
      expect(second.occurrenceId).toBe(first.occurrenceId);
      const rows = await withDb((db) =>
        db.sourceOccurrence.findMany({
          where: { organizationId },
          select: { id: true, computeTargetId: true },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.computeTargetId).toBe(computeTargetId);
    });

    it("ComputeTarget: gateway registration upsert arbitrates on the total (userId, machineName) key across gateway changes", async () => {
      const machineName = `probe-gateway-${randomUUID().slice(0, 8)}`;
      const firstGatewayId = randomUUID();
      const secondGatewayId = randomUUID();

      const first = await computeTargetsService.register(
        organizationId,
        userId,
        {
          machineName,
          platform: "darwin",
          supportedOperations: ["engineer.start"],
          gatewayId: firstGatewayId,
        }
      );
      if (!first.ok) {
        throw new Error(`first gateway register failed: ${first.error}`);
      }

      // The arbiter statement executes on the FIRST call (both the gateway and
      // machine lookups miss, so register falls through to the upsert's create
      // arm — which is the one generated INSERT … ON CONFLICT statement). The
      // second call, with a NEW gatewayId, misses the gateway lookup but HITS
      // the machine-name fast path (findFirst → update-by-id, no upsert); it
      // pins register's idempotent convergence, not a second arbiter run.
      const second = await computeTargetsService.register(
        organizationId,
        userId,
        {
          machineName,
          platform: "darwin",
          supportedOperations: ["engineer.start"],
          gatewayId: secondGatewayId,
        }
      );
      if (!second.ok) {
        throw new Error(`second gateway register failed: ${second.error}`);
      }
      expect(second.value.id).toBe(first.value.id);

      const rows = await withDb((db) =>
        db.computeTarget.findMany({
          where: { organizationId, machineName },
          select: { id: true, gatewayId: true },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.gatewayId).toBe(secondGatewayId);
    });

    it("PullRequestDetail: branch projection upsert arbitrates on the total (repositoryId, number) key, idempotently", async () => {
      const fixture = await seedBranchFixture(organizationId, userId);

      const project = (verifiedAt: Date) =>
        withDb.tx((db) =>
          writeExistingBranchPullRequestProjection(
            db,
            { branchArtifactId: fixture.branchArtifactId },
            {
              organizationId,
              repositoryId: fixture.repositoryId,
              repositoryFullName: fixture.repositoryFullName,
              githubId: `probe-pr-${fixture.repositoryId}`,
              number: 4242,
              title: "Probe PR (PLN-1838 Step 3)",
              htmlUrl: `https://github.com/${fixture.repositoryFullName}/pull/4242`,
              headBranch: "probe-branch",
              baseBranch: "main",
              prState: GitHubPRState.OPEN,
              isDraft: false,
              verifiedAt,
            }
          )
        );

      const first = await project(new Date());
      const second = await project(new Date());

      expect(second.id).toBe(first.id);
      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: {
            organizationId,
            repositoryId: fixture.repositoryId,
            number: 4242,
          },
          select: { id: true },
        })
      );
      expect(rows).toHaveLength(1);
    });

    it("PullRequestDetail: the branch-service statement shape (where githubId) arbitrates on the total githubId unique in both column-set variants", async () => {
      // Statement-shape probe for apps/api/app/branches/branch-service.ts
      // (upsertCurrentPullRequestDetail): driving the production entry needs the
      // full branch-upsert flow, and the arbiter is a property of the GENERATED
      // STATEMENT — model, `where` unique, and column sets — so BOTH column-set
      // variants that site can generate are probed. The production arms are
      // omission-preserving: `pullRequestLocData` drops the LOC keys when the
      // input has none, the update arm spreads `baseRefName` only when non-null,
      // and the provenance spread resolves to no columns when no fetch
      // provenance is supplied. Variant A below is that minimal shape; variant B
      // is the supplied-values shape (LOC and baseRefName present). The
      // statement is sanctioned in no-partial-unique-upsert on the strength of
      // this probe.
      const fixture = await seedBranchFixture(organizationId, userId);

      const projectMinimal = (githubId: string) =>
        withDb.tx((tx) =>
          tx.pullRequestDetail.upsert({
            where: { githubId },
            create: {
              id: randomUUID(),
              branchArtifactId: fixture.branchArtifactId,
              organizationId,
              repositoryId: fixture.repositoryId,
              githubId,
              number: 777,
              title: "Probe PR by githubId (PLN-1838 Step 3, minimal)",
              htmlUrl: `https://github.com/${fixture.repositoryFullName}/pull/777`,
              body: null,
              prState: GitHubPRState.OPEN,
              isDraft: false,
              isCurrent: true,
              githubCreatedAt: null,
              closedAt: null,
              mergedAt: null,
              mergeCommitSha: null,
              baseRefName: null,
            },
            update: {
              title: "Probe PR by githubId (minimal, updated)",
              htmlUrl: `https://github.com/${fixture.repositoryFullName}/pull/777`,
              body: null,
              prState: GitHubPRState.OPEN,
              isDraft: false,
              isCurrent: true,
              githubCreatedAt: null,
              closedAt: null,
              mergedAt: null,
              mergeCommitSha: null,
            },
            select: { id: true },
          })
        );

      const projectSupplied = (githubId: string) =>
        withDb.tx((tx) =>
          tx.pullRequestDetail.upsert({
            where: { githubId },
            create: {
              id: randomUUID(),
              branchArtifactId: fixture.branchArtifactId,
              organizationId,
              repositoryId: fixture.repositoryId,
              githubId,
              number: 778,
              title: "Probe PR by githubId (PLN-1838 Step 3, supplied)",
              htmlUrl: `https://github.com/${fixture.repositoryFullName}/pull/778`,
              body: null,
              prState: GitHubPRState.OPEN,
              isDraft: false,
              additions: 12,
              deletions: 3,
              changedFiles: 2,
              isCurrent: true,
              githubCreatedAt: null,
              closedAt: null,
              mergedAt: null,
              mergeCommitSha: null,
              baseRefName: "main",
            },
            update: {
              title: "Probe PR by githubId (supplied, updated)",
              htmlUrl: `https://github.com/${fixture.repositoryFullName}/pull/778`,
              body: null,
              prState: GitHubPRState.OPEN,
              isDraft: false,
              additions: 12,
              deletions: 3,
              changedFiles: 2,
              isCurrent: true,
              githubCreatedAt: null,
              closedAt: null,
              mergedAt: null,
              mergeCommitSha: null,
              baseRefName: "main",
            },
            select: { id: true },
          })
        );

      const minimalGithubId = `probe-ghid-min-${fixture.repositoryId}`;
      const suppliedGithubId = `probe-ghid-sup-${fixture.repositoryId}`;

      const firstMinimal = await projectMinimal(minimalGithubId);
      const secondMinimal = await projectMinimal(minimalGithubId);
      expect(secondMinimal.id).toBe(firstMinimal.id);

      const firstSupplied = await projectSupplied(suppliedGithubId);
      const secondSupplied = await projectSupplied(suppliedGithubId);
      expect(secondSupplied.id).toBe(firstSupplied.id);

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: { githubId: { in: [minimalGithubId, suppliedGithubId] } },
          select: { id: true },
        })
      );
      expect(rows).toHaveLength(2);
    });

    it("GitHub comment projections: thread and comment upserts arbitrate on their total keys, idempotently", async () => {
      const fixture = await seedBranchFixture(organizationId, userId);
      const detail = await withDb.tx((db) =>
        writeExistingBranchPullRequestProjection(
          db,
          { branchArtifactId: fixture.branchArtifactId },
          {
            organizationId,
            repositoryId: fixture.repositoryId,
            repositoryFullName: fixture.repositoryFullName,
            githubId: `probe-pr-${fixture.branchArtifactId}`,
            number: 555,
            title: "Probe PR for comment projection",
            htmlUrl: `https://github.com/${fixture.repositoryFullName}/pull/555`,
            headBranch: "probe-branch",
            baseBranch: "main",
            prState: GitHubPRState.OPEN,
            isDraft: false,
            verifiedAt: new Date(),
          }
        )
      );
      const githubCommentId = "9910001";

      const projectThread = () =>
        withDb.tx((tx) =>
          upsertGitHubIssueCommentThread(tx, {
            organizationId,
            branchArtifactId: fixture.branchArtifactId,
            pullRequestDetailId: detail.id,
            comment: {
              githubCommentId,
              bodyMarkdown: "Probe comment (PLN-1838 Step 3)",
              author: { userId },
              createdAt: new Date(),
            },
          })
        );

      const first = await projectThread();
      const second = await projectThread();

      expect(second.threadId).toBe(first.threadId);
      const threadRows = await withDb((db) =>
        db.gitHubCommentThreadProjection.findMany({
          where: { threadId: first.threadId },
          select: { threadId: true },
        })
      );
      expect(threadRows).toHaveLength(1);
      const commentRows = await withDb((db) =>
        db.gitHubCommentProjection.findMany({
          where: { threadId: first.threadId },
          select: { commentId: true, githubCommentId: true },
        })
      );
      expect(commentRows).toHaveLength(1);
      expect(commentRows[0]?.githubCommentId).toBe(githubCommentId);
    });
  }
);
