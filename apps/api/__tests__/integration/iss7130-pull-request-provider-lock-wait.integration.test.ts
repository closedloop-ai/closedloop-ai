/**
 * ISS-7130 against a real Postgres: the unit suites prove the bounds are
 * PASSED, not that they WORK. `pg_advisory_xact_lock` only blocks for real
 * against a real lock manager, and the failure being closed here — the waiter's
 * own transaction expiring mid-wait and taking its write with it — is invisible
 * to a mocked `withDb.tx`.
 *
 * The ISS-6980 suite next door does not cover it either: its holders release
 * immediately, so nothing there ever waits past Prisma's default. This case
 * holds the production lock LONGER than that default and no longer than the
 * configured bound, then drives a changed outer writer into it.
 *
 * Scope: what is proven here is that a real waiter survives a real hold past
 * the default it used to die at. The +5s reserved beyond the holder ceiling is
 * an arithmetic invariant, asserted in `pull-request-provider-lock.test.ts` —
 * reproducing it would need a ~30s hold, which is the whole integration tier's
 * per-test budget.
 */
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { branchService } from "@/app/branches/branch-service";
import {
  pullRequestProviderLockHolderTxOptions,
  pullRequestProviderLockKey,
  pullRequestProviderLockTxOptions,
} from "@/app/branches/pull-request-provider-lock";
import {
  createCommittedBranchTestRunner,
  seedBranchTestContext,
} from "./branch-artifact-test-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const runCommittedBranchTest = createCommittedBranchTestRunner(
  seedBranchTestContext,
  () => Promise.resolve()
);

/** Prisma's interactive-transaction default — the bound the fix escapes. */
const PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS = 5000;

/**
 * How long the holder keeps the lock. Past the default a waiter would die at,
 * and well inside the configured bound, so the case is decided by the bound
 * under test rather than by how loaded the box is. Asserted below, not assumed.
 */
const HOLDER_LOCK_HOLD_MS = PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS + 2000;

const PULL_REQUEST_NUMBER = 7130;

describe.skipIf(!hasDatabase)("ISS-7130 PR-provider lock wait", () => {
  it("commits a contended Branch write instead of losing it to P2028", async () => {
    expect(HOLDER_LOCK_HOLD_MS).toBeGreaterThan(
      PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS
    );
    expect(HOLDER_LOCK_HOLD_MS).toBeLessThan(
      pullRequestProviderLockTxOptions.timeout
    );

    await runCommittedBranchTest(async (ctx) => {
      const branchName = "iss-7130/contended-provider-lock";
      const lockKey = pullRequestProviderLockKey({
        organizationId: ctx.organizationId,
        repositoryFullName: ctx.repositoryFullName,
        number: PULL_REQUEST_NUMBER,
      });
      const held = deferred<void>();
      const release = deferred<void>();
      const holder = withDb.tx(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
        held.resolve();
        await release.promise;
      }, pullRequestProviderLockHolderTxOptions);
      await held.promise;

      // A changed outer writer: `upsertBranchArtifactOnce` opens the outermost
      // transaction and takes this same lock, because the input carries a PR
      // and a repository id.
      let settled = false;
      const waiter = branchService.upsertBranchArtifact({
        organizationId: ctx.organizationId,
        repositoryId: ctx.repositoryId,
        repositoryFullName: ctx.repositoryFullName,
        branchName,
        projectId: ctx.projectId,
        pullRequest: {
          githubId: `iss-7130-${ctx.organizationId}`,
          number: PULL_REQUEST_NUMBER,
          title: "Waits out the provider lock",
          htmlUrl: `https://github.com/${ctx.repositoryFullName}/pull/${PULL_REQUEST_NUMBER}`,
          state: GitHubPRState.Open,
        },
      });
      const observed = waiter.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, HOLDER_LOCK_HOLD_MS);
        });

        // NOT the assertion that goes red on the old bounds — measured, not
        // assumed: Prisma does not interrupt a query already in flight, so an
        // expired waiter still sits in `pg_advisory_xact_lock` here (`settled`
        // is false either way) and only rejects on its FIRST query AFTER the
        // lock is granted. That is the `findUnique` inside `upsertBranchArtifact`,
        // so the old bounds fail this case at the write below.
        //
        // What this pins is the precondition that makes that write the subject:
        // the waiter is genuinely queued on the lock rather than sailing past an
        // acquisition that never blocked.
        expect(settled).toBe(false);
      } finally {
        // Released even on a failed assertion: an open holder would otherwise
        // outlive the test and reject unhandled, masking the real failure.
        release.resolve();
        await Promise.allSettled([holder, observed]);
      }

      const [, result] = await Promise.all([holder, waiter]);
      if (!result.ok) {
        throw new Error(`Contended Branch write failed: ${result.error}`);
      }

      await expect(
        withDb((db) =>
          db.pullRequestDetail.findFirst({
            where: {
              organizationId: ctx.organizationId,
              number: PULL_REQUEST_NUMBER,
            },
            select: { branchArtifactId: true, githubId: true },
          })
        )
      ).resolves.toEqual({
        branchArtifactId: result.value.id,
        githubId: `iss-7130-${ctx.organizationId}`,
      });
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
