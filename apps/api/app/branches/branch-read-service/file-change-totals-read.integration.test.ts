import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { toBranchFileChangeTotals } from "@/__tests__/support/branches/branch-file-change-totals.test-helpers";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { currentFileTotals } from "@/app/branches/branch-loc";
import {
  EMPTY_BRANCH_FILE_CHANGE_TOTALS,
  getBranchFileChangeTotals,
} from "@/app/branches/branch-read-service/file-change-totals-read";

/**
 * ISS-10298 — the file-cache fold moved out of JavaScript and into one grouped
 * statement, so only a real Postgres can prove it still answers what the
 * per-file fold answered. Asserted against ROWS a real database returned, never
 * against generated SQL text.
 *
 * The case that matters is the PARTIAL cache: the database's `SUM` skips
 * `NULL`s, so a naive fold would report a confident total over only the files
 * that enriched, which `isLocEnriched` accepts and every LOC surface then
 * presents as a measured size. Every case below is stated twice — once as the
 * value the grouped statement produced, once as the value the in-memory
 * reference fold produces from the same rows — so a divergence fails rather
 * than being read past.
 *
 * Each case also seeds a branch the read must NOT fold into another's totals,
 * so an assertion cannot pass by the statement simply summing everything.
 *
 * Runs inside `autoRollbackTransaction`; nothing persists.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const SEEDED_AT = new Date("2026-07-01T00:00:00.000Z");
const HEAD_SHA = "a".repeat(40);
const OTHER_HEAD_SHA = "b".repeat(40);

type SeededFile = [additions: number | null, deletions: number | null];

describeIfDb("getBranchFileChangeTotals", () => {
  it("folds a fully-enriched cache to the same totals the per-file fold gives", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const files: SeededFile[] = [
        [10, 5],
        [2, 3],
      ];
      const branchId = await seedBranch(organizationId, "enriched", files);
      const otherId = await seedBranch(organizationId, "other", [[999, 999]]);

      const totals = await withDb((db) =>
        getBranchFileChangeTotals(db, organizationId, [branchId, otherId])
      );

      expect(totals.get(branchId)).toEqual({
        additions: 12,
        deletions: 8,
        fileCount: 2,
        headSha: HEAD_SHA,
      });
      expect(totals.get(branchId)).toEqual(referenceFold(files));
      expect(totals.get(otherId)).toEqual({
        additions: 999,
        deletions: 999,
        fileCount: 1,
        headSha: HEAD_SHA,
      });
    });
  });

  it("reads a dimension as UNAVAILABLE when any one file's count is null", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const files: SeededFile[] = [
        [10, 5],
        [null, 3],
      ];
      const branchId = await seedBranch(organizationId, "partial", files);
      const completeId = await seedBranch(organizationId, "complete", [[1, 1]]);

      const totals = await withDb((db) =>
        getBranchFileChangeTotals(db, organizationId, [branchId, completeId])
      );

      // NOT `{ additions: 10 }` — the sum over the files that did enrich is the
      // confident-looking wrong answer this whole rule exists to refuse.
      expect(totals.get(branchId)).toEqual({
        additions: null,
        deletions: 8,
        fileCount: 2,
        headSha: HEAD_SHA,
      });
      expect(totals.get(branchId)).toEqual(referenceFold(files));
      // The sibling proves the null is the partial file's doing, not the read
      // failing to sum at all.
      expect(totals.get(completeId)?.additions).toBe(1);
    });
  });

  it("sums an all-zero column to zero rather than to unavailable", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const files: SeededFile[] = [
        [0, 0],
        [0, 4],
      ];
      const branchId = await seedBranch(organizationId, "zeroed", files);

      const totals = await withDb((db) =>
        getBranchFileChangeTotals(db, organizationId, [branchId])
      );

      expect(totals.get(branchId)).toEqual({
        additions: 0,
        deletions: 4,
        fileCount: 2,
        headSha: HEAD_SHA,
      });
      expect(totals.get(branchId)).toEqual(referenceFold(files));
    });
  });

  it("returns no entry for a branch with no cached files, which reads as unknown LOC", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const branchId = await seedBranch(organizationId, "uncached", []);

      const totals = await withDb((db) =>
        getBranchFileChangeTotals(db, organizationId, [branchId])
      );

      expect(totals.has(branchId)).toBe(false);
      // The absence has to resolve the way an empty row set did at the surface
      // that consumes it, not merely be absent in the map.
      expect(
        currentFileTotals(EMPTY_BRANCH_FILE_CHANGE_TOTALS, HEAD_SHA, HEAD_SHA)
      ).toEqual({ additions: null, deletions: null, filesChanged: null });
    });
  });

  // A refresh deletes a branch's rows before writing the new head's, so rows for
  // two heads coexist only mid-flight. The relation load this replaced had no
  // head predicate and summed both diffs together as a measured size.
  it("reads a branch caught mid-refresh as unknown, not as a sum across two heads", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const branchId = await seedBranch(organizationId, "mid-refresh", [
        [10, 5],
      ]);
      await withDb((db) =>
        db.branchFileChange.create({
          data: {
            branchArtifactId: branchId,
            headSha: OTHER_HEAD_SHA,
            path: "src/new.ts",
            status: FileChangeStatus.Modified,
            additions: 400,
            deletions: 200,
          },
        })
      );

      const totals = await withDb((db) =>
        getBranchFileChangeTotals(db, organizationId, [branchId])
      );

      expect(totals.get(branchId)).toEqual(EMPTY_BRANCH_FILE_CHANGE_TOTALS);
      expect(
        currentFileTotals(
          totals.get(branchId) ?? EMPTY_BRANCH_FILE_CHANGE_TOTALS,
          HEAD_SHA,
          HEAD_SHA
        )
      ).toEqual({ additions: null, deletions: null, filesChanged: null });
    });
  });

  it("folds nothing for a branch owned by another organization", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const otherOrganizationId = await createTestOrganization();
      const foreignId = await seedBranch(otherOrganizationId, "foreign", [
        [7, 7],
      ]);
      const ownId = await seedBranch(organizationId, "own", [[1, 2]]);

      const totals = await withDb((db) =>
        getBranchFileChangeTotals(db, organizationId, [ownId, foreignId])
      );

      expect(totals.has(foreignId)).toBe(false);
      expect(totals.get(ownId)).toEqual({
        additions: 1,
        deletions: 2,
        fileCount: 1,
        headSha: HEAD_SHA,
      });
    });
  });
});

function referenceFold(files: readonly SeededFile[]) {
  return toBranchFileChangeTotals(
    files.map(([additions, deletions]) => ({ additions, deletions })),
    HEAD_SHA
  );
}

async function seedBranch(
  organizationId: string,
  branchName: string,
  files: readonly SeededFile[]
): Promise<string> {
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: `acme/${branchName}`,
        branchName,
        firstPushedAt: SEEDED_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: SEEDED_AT,
        headSha: HEAD_SHA,
        fileCacheHeadSha: HEAD_SHA,
        fileCacheFileCount: files.length,
      },
      select: { artifactId: true },
    });
    if (files.length > 0) {
      await db.branchFileChange.createMany({
        data: files.map(([additions, deletions], index) => ({
          branchArtifactId: artifact.id,
          headSha: HEAD_SHA,
          path: `src/file-${index}.ts`,
          status: FileChangeStatus.Modified,
          additions,
          deletions,
        })),
      });
    }
    return artifact.id;
  });
}
