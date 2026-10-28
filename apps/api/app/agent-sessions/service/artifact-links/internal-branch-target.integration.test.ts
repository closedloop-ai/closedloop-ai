import { ArtifactType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { ensureInternalBranchActivityTargets } from "./internal-branch-target";
import type { SessionBranchRepositoryAuthority } from "./shared";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

const REPO_FULL_NAME = "acme/web";

/**
 * Resolved and free of `identityConflict` — the two conditions the production
 * filter admits on. `repositoryId: null` is the ordinary desktop shape rather
 * than a degenerate one: `BranchDetail.repositoryId` is nullable installation
 * enrichment, and a branch in a repo with no GitHub App install carries none.
 */
const RESOLVED_AUTHORITY: SessionBranchRepositoryAuthority = {
  repositoryId: null,
  authorities: [],
  identitySources: new Set(),
};

/**
 * ISS-8780 — `ensureInternalBranchActivityTargets` against real Postgres.
 *
 * This lives in the DB-backed lane rather than beside the unit suites because
 * the defect it guards is INVISIBLE to a transaction double. `mockWithDbTx`
 * (`__tests__/utils/db-helpers.ts`) hands every mocked tx a default `$queryRaw`
 * resolving `[]` and a default `$executeRaw` resolving `0`, so a unit test that
 * drives this function and asserts on SQL shape passes identically whether the
 * lock is issued with the row-returning verb or the executing one. Only a real
 * driver refuses `pg_advisory_xact_lock()`'s `void` column, which is why the
 * bug reached production behind a green suite.
 *
 * Every case below reaches the lock statement, so any of them fails on a
 * regression to `$queryRaw`. They differ in what they pin AFTER it.
 */
describeIfDb(
  "internal branch activity targets (ISS-8780, real Postgres)",
  () => {
    it("materializes a target whose authority resolved", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const branchName = "feat/iss8780-single";

        const materialized = await withDb((db) =>
          ensureInternalBranchActivityTargets(db, {
            organizationId,
            projectId: null,
            targets: [branchTarget(branchName)],
          })
        );

        // The KEY shape is contract, not incidental: the caller
        // (`monitored-session-activity.ts`) looks the id up by an identity it
        // builds itself, so a divergence here strands every materialized target.
        expect([...materialized.keys()]).toEqual([identity(branchName)]);

        const branchRow = await readBranchRow(organizationId, branchName);
        expect(branchRow.repositoryId).toBeNull();
        expect(materialized.get(identity(branchName))).toBe(
          branchRow.artifactId
        );

        const artifact = await withDb((db) =>
          db.artifact.findUniqueOrThrow({
            where: { id: branchRow.artifactId },
            select: { type: true, name: true, organizationId: true },
          })
        );
        expect(artifact).toEqual({
          type: ArtifactType.Branch,
          name: branchName,
          organizationId,
        });
      });
    });

    it("materializes every target when one call carries several", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        // Deliberately not in sorted order. The acquisition ORDER is pinned by
        // the sibling unit suite, which can see one `$executeRaw` per key; this
        // case only proves several targets each land on their own row.
        const branchNames = ["feat/iss8780-z", "feat/iss8780-a"];

        const materialized = await withDb((db) =>
          ensureInternalBranchActivityTargets(db, {
            organizationId,
            projectId: null,
            targets: branchNames.map(branchTarget),
          })
        );

        expect([...materialized.keys()].sort()).toEqual(
          branchNames.map(identity).sort()
        );
        const rows = await withDb((db) =>
          db.branchDetail.findMany({
            where: { organizationId },
            select: { artifactId: true, branchName: true },
          })
        );
        expect(rows.map((row) => row.branchName).sort()).toEqual(
          [...branchNames].sort()
        );
        // Per branch, not as a set: a defect that returned the right SET of ids
        // against the wrong keys — branch A's id under branch B's identity —
        // satisfies every set comparison above it.
        for (const row of rows) {
          expect(materialized.get(identity(row.branchName))).toBe(
            row.artifactId
          );
        }
      });
    });

    it("adopts the row another writer already created for the same identity", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const branchName = "feat/iss8780-webhook";
        // Stands in for `branchService.upsertBranchArtifact`, the push-webhook
        // writer: same PRD-510 D2 identity, its own artifact, and no
        // branch-identity advisory lock. Covers the RECHECK path — the row is
        // already committed when this helper looks. The interleaving where it
        // lands between the recheck and the insert is what `skipDuplicates`
        // handles, and reproducing that needs two concurrent transactions.
        const foreignArtifactId = await withDb(async (db) => {
          const artifact = await db.artifact.create({
            data: {
              organizationId,
              type: ArtifactType.Branch,
              name: branchName,
              status: GitHubPRState.Open,
            },
            select: { id: true },
          });
          await db.branchDetail.create({
            data: {
              artifactId: artifact.id,
              organizationId,
              repositoryFullName: REPO_FULL_NAME,
              branchName,
            },
            select: { artifactId: true },
          });
          return artifact.id;
        });

        const materialized = await withDb((db) =>
          ensureInternalBranchActivityTargets(db, {
            organizationId,
            projectId: null,
            targets: [branchTarget(branchName)],
          })
        );

        expect(materialized.get(identity(branchName))).toBe(foreignArtifactId);
        // No competing artifact was minted beside the adopted row — the count is
        // the assertion, since the returned id alone cannot see an orphan.
        await expect(
          withDb((db) =>
            db.artifact.count({
              where: { organizationId, type: ArtifactType.Branch },
            })
          )
        ).resolves.toBe(1);
        await expect(
          withDb((db) => db.branchDetail.count({ where: { organizationId } }))
        ).resolves.toBe(1);
      });
    });

    it("returns the existing artifact id for an identity it already materialized", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const branchName = "feat/iss8780-repeat";
        const call = () =>
          withDb((db) =>
            ensureInternalBranchActivityTargets(db, {
              organizationId,
              projectId: null,
              targets: [branchTarget(branchName)],
            })
          );

        const first = await call();
        const second = await call();

        expect(second.get(identity(branchName))).toBe(
          first.get(identity(branchName))
        );
        // Both calls join this suite's ambient transaction, so what is pinned is
        // the existing-row path — NOT cross-transaction lock contention, which
        // would need committed data and concurrent writers. The row count is here
        // because the returned id alone would not catch a second INSERT that the
        // `@@unique([organizationId, repositoryFullName, branchName])` index then
        // rejected.
        await expect(
          withDb((db) => db.branchDetail.count({ where: { organizationId } }))
        ).resolves.toBe(1);
      });
    });
  }
);

function branchTarget(branchName: string) {
  return {
    repositoryAuthority: RESOLVED_AUTHORITY,
    repositoryFullName: REPO_FULL_NAME,
    branchName,
  };
}

/** Mirrors the module-private `internalBranchTargetIdentity` key shape. */
function identity(branchName: string): string {
  return `${REPO_FULL_NAME}\u0000${branchName}`;
}

function readBranchRow(organizationId: string, branchName: string) {
  return withDb((db) =>
    db.branchDetail.findUniqueOrThrow({
      where: {
        organizationId_repositoryFullName_branchName: {
          organizationId,
          repositoryFullName: REPO_FULL_NAME,
          branchName,
        },
      },
      select: { artifactId: true, repositoryId: true },
    })
  );
}
