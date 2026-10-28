/**
 * ISS-9116: the backfill projection WRITE path read one branch row per incoming
 * pull request, inside a single interactive transaction capped at 30 s, while
 * its dry-run sibling already answered that same scope in one batched
 * statement. At `PULL_REQUEST_BACKFILL_MAX_ITEMS` (500) that is 500 serial
 * round trips the payload never needed.
 *
 * The PR identity read stays per-pull-request on purpose — a set-shaped
 * `pullRequestDetail` read in `apps/api` must declare a sanctioned population
 * and this lane belongs to none of them — so the counts below are branch reads,
 * not every statement the loop issues.
 *
 * The assertions are STATEMENT COUNTS, never elapsed time
 * (`scripts/lint/rules/no-timing-assertions.ts`), and every expected count is an
 * independently written literal rather than a value re-derived from the code
 * under test.
 */

import { randomUUID } from "node:crypto";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { keys } from "@repo/database/keys";
import { describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the counter is pulled in HERE
// rather than referenced from a top-level binding that is still in its temporal
// dead zone when this factory runs.
vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const { countingWithDb } = await import(
    "@/__tests__/support/prisma-statement-counter"
  );
  return { ...actual, withDb: countingWithDb(actual) };
});

import { ArtifactType, withDb } from "@repo/database";
import {
  occurrences,
  startCounting,
} from "@/__tests__/support/prisma-statement-counter";
import {
  findBackfillBranch,
  loadBackfillBranchesByName,
  openBackfillProjectionReads,
} from "@/app/integrations/github/backfill-projection-reads";
import { githubBackfillProjectionWriter } from "@/app/integrations/github/backfill-projection-writer";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "../utils/db-helpers";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin the batched READ shape through the statement counter, which forwards a budget it cannot honor inside this wrapper; no case asserts a commit boundary"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY = "acme/iss9116";
/** App-lane repo for the rename case; see `seedRenamedRepositoryDuplicate`. */
const RENAMED_REPOSITORY = "acme/iss9116-renamed";
const CREDENTIAL = {
  type: GitHubFetchCredentialType.UserOAuth,
  ownerId: null,
} as const;

/**
 * The whole point of the fix: ONE branch statement answers a payload of any
 * size, so this literal must NOT move when the seeded PR count does.
 */
const BATCHED_BRANCH_STATEMENTS = 1;

/**
 * Statements the write loop issues per pull request AFTER the branch read was
 * hoisted. Captured from a measured run and pinned here by hand: before the fix
 * this was one higher — the per-pull-request `branchDetail.findFirst` — and that
 * is exactly what the counterfactual restores.
 */
const WRITE_STATEMENTS_PER_PULL_REQUEST = 12;

/** Comfortably past `PULL_REQUEST_BACKFILL_MAX_ITEMS` cannot be seeded cheaply; this is that cap. */
const BACKFILL_MAX_ITEMS = 500;

/**
 * The interactive-transaction bound for the two tests that seed hundreds of
 * rows before measuring — Prisma's 5 s default is not enough for those.
 *
 * Under the tier's own `testTimeout` (30 s in `vitest.config.integration.mts`),
 * because `__tests__/integration-suite-timeout-budget.test.ts` (ISS-8542) fails
 * any collected suite that declares a bound its phase cannot enforce, and its
 * grandfather ledger is shrink-only. The whole eight-test suite measured 1988 ms
 * on CI, so this is headroom, not a budget anything here spends.
 */
const BACKFILL_TRANSACTION_TIMEOUT_MS = 25_000;

function providerPullRequest(
  index: number,
  options?: { headBranch?: string; namespace?: string }
) {
  const number = index + 1;
  return {
    // Globally unique column, so every test seeds under its own namespace.
    githubId: `PR_iss9116_${options?.namespace ?? "default"}_${number}`,
    number,
    title: `Pull request ${number}`,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${number}`,
    headBranch: options?.headBranch ?? `feat/iss9116-${number}`,
    baseBranch: "main",
    headSha: `head-sha-${number}`,
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-09-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}

/**
 * One repo-less org carrying a branch artifact and an existing PR row per
 * incoming pull request, so the write path takes its full projection branch
 * rather than the repo-less skip.
 */
async function seedRepoLessBackfill(
  pullRequests: ReturnType<typeof providerPullRequest>[]
) {
  const organizationId = await createTestOrganization();
  const artifactIds = pullRequests.map(() => randomUUID());
  await withDb((db) =>
    db.artifact.createMany({
      data: pullRequests.map((pullRequest, index) => ({
        id: artifactIds[index] as string,
        organizationId,
        type: ArtifactType.BRANCH,
        name: pullRequest.headBranch,
        status: GitHubPRState.Open,
      })),
    })
  );
  await withDb((db) =>
    db.branchDetail.createMany({
      data: pullRequests.map((pullRequest, index) => ({
        artifactId: artifactIds[index] as string,
        organizationId,
        repositoryFullName: REPOSITORY,
        branchName: pullRequest.headBranch,
      })),
    })
  );
  await withDb((db) =>
    db.pullRequestDetail.createMany({
      data: pullRequests.map((pullRequest, index) => ({
        organizationId,
        branchArtifactId: artifactIds[index] as string,
        repositoryFullName: REPOSITORY,
        githubId: pullRequest.githubId,
        number: pullRequest.number,
        title: "Stale title",
        htmlUrl: pullRequest.htmlUrl,
        prState: GitHubPRState.Open,
        isCurrent: true,
      })),
    })
  );
  return { organizationId, artifactIds };
}

/**
 * One App-lane repository carrying TWO branch rows under one branch name —
 * what a repository RENAME leaves behind. `(organizationId,
 * repositoryFullName, branchName)` is unique, but the App lane's predicate is
 * `{ repositoryId }`, which no unique constraint pairs with `branchName`, so
 * both rows match it.
 *
 * Seeded in ASCENDING artifact-id order on purpose: unordered, `findMany`
 * returns insertion order and a last-wins Map keeps the SECOND row while
 * `findFirst` keeps the first. That is the disagreement the canonical ordering
 * exists to remove, and seeding the other way round would hide it.
 */
async function seedRenamedRepositoryDuplicate(branchName: string) {
  const organizationId = await createTestOrganization();
  const suffix = randomUUID();
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `install-${suffix}`,
        accountId: `account-${suffix}`,
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "octocat",
        senderId: `sender-${suffix}`,
      },
      select: { id: true },
    })
  );
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.create({
      data: {
        installationId: installation.id,
        githubRepoId: `repo-${suffix}`,
        fullName: RENAMED_REPOSITORY,
        name: RENAMED_REPOSITORY.split("/")[1] as string,
        owner: RENAMED_REPOSITORY.split("/")[0] as string,
        private: false,
      },
      select: { id: true },
    })
  );
  const [canonicalArtifactId, shadowArtifactId] = [
    randomUUID(),
    randomUUID(),
  ].sort() as [string, string];
  await withDb((db) =>
    db.artifact.createMany({
      data: [canonicalArtifactId, shadowArtifactId].map((id) => ({
        id,
        organizationId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: GitHubPRState.Open,
      })),
    })
  );
  await withDb((db) =>
    db.branchDetail.createMany({
      data: [
        {
          artifactId: canonicalArtifactId,
          organizationId,
          repositoryId: repository.id,
          repositoryFullName: `${RENAMED_REPOSITORY}-before-rename`,
          branchName,
        },
        {
          artifactId: shadowArtifactId,
          organizationId,
          repositoryId: repository.id,
          repositoryFullName: RENAMED_REPOSITORY,
          branchName,
        },
      ],
    })
  );
  return {
    organizationId,
    repositoryId: repository.id,
    canonicalArtifactId,
    shadowArtifactId,
  };
}

function readScope(organizationId: string) {
  return { organizationId, repository: { id: null, fullName: REPOSITORY } };
}

function writeInput(
  organizationId: string,
  pullRequests: ReturnType<typeof providerPullRequest>[]
) {
  return {
    organizationId,
    repository: { id: null, fullName: REPOSITORY },
    pullRequests,
    credential: CREDENTIAL,
  };
}

describeIfDb("ISS-9116 backfill projection batched reads", () => {
  it("answers a full 500-pull-request payload in one branch statement", async () => {
    await joinAmbientTransaction(
      async () => {
        const pullRequests = Array.from(
          { length: BACKFILL_MAX_ITEMS },
          (_, index) => providerPullRequest(index, { namespace: "bulk" })
        );
        const { organizationId } = await seedRepoLessBackfill(pullRequests);

        const collect = startCounting();
        await withDb(async (tx) => {
          const reads = await openBackfillProjectionReads(
            tx,
            readScope(organizationId),
            pullRequests
          );
          for (const pullRequest of pullRequests) {
            const { branch, existing } = await reads.resolve(pullRequest);
            expect(branch).not.toBeNull();
            expect(existing).not.toBeNull();
          }
        });

        expect(occurrences(collect(), "branchDetail.findMany")).toBe(
          BATCHED_BRANCH_STATEMENTS
        );
        expect(occurrences(collect(), "branchDetail.findFirst")).toBe(0);
      },
      { timeout: BACKFILL_TRANSACTION_TIMEOUT_MS }
    );
  });

  it("costs the same one branch statement for a five-pull-request payload", async () => {
    await joinAmbientTransaction(async () => {
      const pullRequests = Array.from({ length: 5 }, (_, index) =>
        providerPullRequest(index, { namespace: "small" })
      );
      const { organizationId } = await seedRepoLessBackfill(pullRequests);

      const collect = startCounting();
      await withDb(async (tx) => {
        const reads = await openBackfillProjectionReads(
          tx,
          readScope(organizationId),
          pullRequests
        );
        for (const pullRequest of pullRequests) {
          await reads.resolve(pullRequest);
        }
      });

      const issued = collect();
      expect(occurrences(issued, "branchDetail.findMany")).toBe(
        BATCHED_BRANCH_STATEMENTS
      );
      expect(occurrences(issued, "branchDetail.findFirst")).toBe(0);
    });
  });

  it("re-reads a head branch this transaction has already written", async () => {
    await joinAmbientTransaction(async () => {
      const shared = "feat/iss9116-shared";
      const pullRequests = [
        providerPullRequest(0, { headBranch: shared, namespace: "shared" }),
        providerPullRequest(1, { headBranch: shared, namespace: "shared" }),
      ];
      const { organizationId, artifactIds } = await seedRepoLessBackfill([
        pullRequests[0],
      ]);
      await withDb((db) =>
        db.pullRequestDetail.createMany({
          data: [
            {
              organizationId,
              branchArtifactId: artifactIds[0] as string,
              repositoryFullName: REPOSITORY,
              githubId: pullRequests[1].githubId,
              number: pullRequests[1].number,
              title: "Second PR off one branch",
              htmlUrl: pullRequests[1].htmlUrl,
              prState: GitHubPRState.Open,
            },
          ],
        })
      );

      const collect = startCounting();
      await withDb(async (tx) => {
        const reads = await openBackfillProjectionReads(
          tx,
          readScope(organizationId),
          pullRequests
        );
        const first = await reads.resolve(pullRequests[0]);
        expect(first.branch).not.toBeNull();
        reads.markWritten({
          pullRequest: pullRequests[0],
          branch: first.branch as NonNullable<typeof first.branch>,
          existing: first.existing,
        });
        const second = await reads.resolve(pullRequests[1]);
        expect(second.branch?.branchName).toBe(shared);
        expect(second.existing?.number).toBe(pullRequests[1].number);
      });

      const issued = collect();
      // The batch, plus the one branch statement the second pull request pays
      // because the first one invalidated it.
      expect(occurrences(issued, "branchDetail.findMany")).toBe(
        BATCHED_BRANCH_STATEMENTS
      );
      expect(occurrences(issued, "branchDetail.findFirst")).toBe(1);
    });
  });

  it("re-reads a branch the batch missed once this transaction has written", async () => {
    await joinAmbientTransaction(async () => {
      const seeded = providerPullRequest(0, { namespace: "adopted" });
      // Never seeded, so the up-front batch has no row for it. A miss is only
      // trustworthy until a write happens, because projecting a PR can adopt a
      // branch row into this repository's scope mid-transaction.
      const unseeded = providerPullRequest(1, { namespace: "adopted" });
      const { organizationId } = await seedRepoLessBackfill([seeded]);

      const collect = startCounting();
      await withDb(async (tx) => {
        const reads = await openBackfillProjectionReads(
          tx,
          readScope(organizationId),
          [seeded, unseeded]
        );
        const before = await reads.resolve(unseeded);
        expect(before.branch).toBeNull();
        const seededRead = await reads.resolve(seeded);
        expect(seededRead.branch).not.toBeNull();
        reads.markWritten({
          pullRequest: seeded,
          branch: seededRead.branch as NonNullable<typeof seededRead.branch>,
          existing: seededRead.existing,
        });
        const after = await reads.resolve(unseeded);
        expect(after.branch).toBeNull();
      });

      const issued = collect();
      expect(occurrences(issued, "branchDetail.findMany")).toBe(
        BATCHED_BRANCH_STATEMENTS
      );
      // The pre-write miss is served from the batch; the post-write one is not.
      expect(occurrences(issued, "branchDetail.findFirst")).toBe(1);
    });
  });

  it("selects the same branch row the per-branch read selects", async () => {
    await joinAmbientTransaction(async () => {
      const pullRequests = Array.from({ length: 8 }, (_, index) =>
        providerPullRequest(index, { namespace: "agreement" })
      );
      const { organizationId } = await seedRepoLessBackfill(pullRequests);
      const scope = readScope(organizationId);
      const absent = providerPullRequest(99, { namespace: "agreement" });

      await withDb(async (tx) => {
        const byName = await loadBackfillBranchesByName(tx, scope, [
          ...pullRequests,
          absent,
        ]);
        for (const pullRequest of [...pullRequests, absent]) {
          const perBranch = await findBackfillBranch(
            tx,
            scope,
            pullRequest.headBranch
          );
          expect(byName.get(pullRequest.headBranch)?.artifactId ?? null).toBe(
            perBranch?.artifactId ?? null
          );
        }
        // The unseeded branch resolves to nothing through both shapes, so the
        // batch cannot report a branch the per-branch read would have missed.
        expect(byName.get(absent.headBranch)).toBeUndefined();
      });
    });
  });

  it("resolves a duplicated branch name to one row across the batch and the fallback", async () => {
    await joinAmbientTransaction(async () => {
      const branchName = "feat/iss9116-renamed";
      const { organizationId, repositoryId, canonicalArtifactId } =
        await seedRenamedRepositoryDuplicate(branchName);
      const scope = {
        organizationId,
        repository: { id: repositoryId, fullName: RENAMED_REPOSITORY },
      };
      const pullRequest = providerPullRequest(0, {
        headBranch: branchName,
        namespace: "renamed",
      });

      await withDb(async (tx) => {
        const byName = await loadBackfillBranchesByName(tx, scope, [
          pullRequest,
        ]);
        const perBranch = await findBackfillBranch(tx, scope, branchName);
        // Pinned to the seeded id, not to whatever the sibling read returned:
        // two reads agreeing on an arbitrary row is the bug, not the contract.
        expect(byName.get(branchName)?.artifactId).toBe(canonicalArtifactId);
        expect(perBranch?.artifactId).toBe(canonicalArtifactId);

        const reads = await openBackfillProjectionReads(tx, scope, [
          pullRequest,
        ]);
        const first = await reads.resolve(pullRequest);
        expect(first.branch?.artifactId).toBe(canonicalArtifactId);
        reads.markWritten({
          pullRequest,
          branch: first.branch as NonNullable<typeof first.branch>,
          existing: first.existing,
        });
        // Past `markWritten` the batched row is retired and this name is served
        // by `findBackfillBranch` instead. A different row here would let ONE
        // backfill attach its later pull requests to a different historical
        // branch than its first, and flip `currentPullRequestDetailId` on it.
        const second = await reads.resolve(pullRequest);
        expect(second.branch?.artifactId).toBe(canonicalArtifactId);
      });
    });
  });

  it("keeps the per-pull-request write cost free of the hoisted branch read", async () => {
    await joinAmbientTransaction(
      async () => {
        const three = Array.from({ length: 3 }, (_, index) =>
          providerPullRequest(index, { namespace: "slope-three" })
        );
        const six = Array.from({ length: 6 }, (_, index) =>
          providerPullRequest(index, { namespace: "slope-six" })
        );
        const small = await seedRepoLessBackfill(three);
        const large = await seedRepoLessBackfill(six);

        const collectSmall = startCounting();
        await githubBackfillProjectionWriter.write(
          writeInput(small.organizationId, three)
        );
        const smallStatements = collectSmall();
        const smallTotal = smallStatements.length;

        const collectLarge = startCounting();
        await githubBackfillProjectionWriter.write(
          writeInput(large.organizationId, six)
        );
        const largeTotal = collectLarge().length;

        expect((largeTotal - smallTotal) / 3).toBe(
          WRITE_STATEMENTS_PER_PULL_REQUEST
        );
        // Doubling the payload buys no extra batched branch read. Counted
        // rather than pinned to a literal because this path issues one further
        // `branchDetail.findMany` of its own, in the lifecycle-atom batch — the
        // claim under test is that the number does not move with payload size.
        expect(occurrences(collectLarge(), "branchDetail.findMany")).toBe(
          occurrences(smallStatements, "branchDetail.findMany")
        );
      },
      { timeout: BACKFILL_TRANSACTION_TIMEOUT_MS }
    );
  });

  it("invalidates the branch snapshot through the production write path", async () => {
    await joinAmbientTransaction(async () => {
      const shared = "feat/iss9116-write-shared";
      const sharedBranch = [
        providerPullRequest(0, { headBranch: shared, namespace: "shared-w" }),
        providerPullRequest(1, { headBranch: shared, namespace: "shared-w" }),
      ];
      const distinctBranches = Array.from({ length: 2 }, (_, index) =>
        providerPullRequest(index, { namespace: "distinct-w" })
      );
      const sharedScope = await seedRepoLessBackfill([sharedBranch[0]]);
      await withDb((db) =>
        db.pullRequestDetail.createMany({
          data: [
            {
              organizationId: sharedScope.organizationId,
              branchArtifactId: sharedScope.artifactIds[0] as string,
              repositoryFullName: REPOSITORY,
              githubId: sharedBranch[1].githubId,
              number: sharedBranch[1].number,
              title: "Second PR off one branch",
              htmlUrl: sharedBranch[1].htmlUrl,
              prState: GitHubPRState.Open,
            },
          ],
        })
      );
      const distinctScope = await seedRepoLessBackfill(distinctBranches);

      const collectDistinct = startCounting();
      await githubBackfillProjectionWriter.write(
        writeInput(distinctScope.organizationId, distinctBranches)
      );
      const distinctReads = occurrences(
        collectDistinct(),
        "branchDetail.findFirst"
      );

      const collectShared = startCounting();
      await githubBackfillProjectionWriter.write(
        writeInput(sharedScope.organizationId, sharedBranch)
      );
      const sharedReads = occurrences(
        collectShared(),
        "branchDetail.findFirst"
      );

      // Same payload size, same seeded shape — the ONLY difference is that the
      // second payload's two pull requests share a head branch, so the write
      // loop must retire the batched row before resolving the second one. Drop
      // `markWritten` at that call site and both payloads read alike.
      expect(sharedReads).toBe(distinctReads + 1);
    });
  });

  it("writes the same projection the per-pull-request reads produced", async () => {
    await joinAmbientTransaction(async () => {
      const pullRequests = Array.from({ length: 4 }, (_, index) =>
        providerPullRequest(index, { namespace: "output" })
      );
      const { organizationId, artifactIds } =
        await seedRepoLessBackfill(pullRequests);

      const diff = await githubBackfillProjectionWriter.write(
        writeInput(organizationId, pullRequests)
      );

      expect(diff).toEqual({
        branchProjectionChangeCount: 4,
        pullRequestProjectionChangeCount: 4,
        lifecycleAtomProjectionChangeCount: 4,
        branchLastActivityProjectionChangeCount: 4,
        reviewDecisionProjectionChangeCount: 0,
        checkProjectionChangeCount: 0,
        issueCommentProjectionChangeCount: 0,
        reviewCommentProjectionChangeCount: 0,
        reviewThreadProjectionChangeCount: 0,
        reviewProjectionChangeCount: 0,
        statusCheckProjectionChangeCount: 0,
        skippedBranchCount: 0,
      });

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: { organizationId },
          orderBy: { number: "asc" },
          select: { number: true, title: true, htmlUrl: true, isCurrent: true },
        })
      );
      expect(rows).toEqual(
        pullRequests.map((pullRequest) => ({
          number: pullRequest.number,
          title: pullRequest.title,
          htmlUrl: pullRequest.htmlUrl,
          isCurrent: true,
        }))
      );

      const branches = await withDb((db) =>
        db.branchDetail.findMany({
          where: { artifactId: { in: artifactIds } },
          orderBy: { branchName: "asc" },
          select: { branchName: true, baseBranch: true, headSha: true },
        })
      );
      expect(branches).toHaveLength(4);
      for (const branch of branches) {
        expect(branch.baseBranch).toBe("main");
      }
    });
  });
});
