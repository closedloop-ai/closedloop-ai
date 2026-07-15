import { randomUUID } from "node:crypto";
import { ArtifactType, withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import { branchService } from "@/app/branches/branch-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

/**
 * PRD-510 FR13 invariant (PLN-1099 Phase 0): `BranchDetail.organizationId` is a
 * write-once denormalization of the parent `Artifact.organizationId` (the org
 * SSOT). Every branch row must satisfy `branch_detail.organization_id =
 * artifacts.organization_id`; this suite fails loud on drift and also proves the
 * D2 key column (`repository_full_name`) is stored normalized.
 *
 * Each test runs inside `autoRollbackTransaction`, so all seeded rows are rolled
 * back — no manual cleanup, and no cross-test residue (the org→artifact/project/
 * user/installation FKs are RESTRICT, so a direct `organization.delete` teardown
 * would throw anyway).
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function seedRepo(
  organizationId: string
): Promise<{ repositoryId: string; repositoryFullName: string }> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const fullName = `Org/Repo-${suffix}`;
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
        repositories: {
          create: {
            githubRepoId: `repo-${suffix}`,
            fullName,
            name: "repo",
            owner: "org",
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
  return { repositoryId: repo.id, repositoryFullName: repo.fullName };
}

describe.skipIf(!hasDatabase)("branch org-SSOT (FR13) invariant", () => {
  it("writes branch_detail.organization_id from the parent artifact and normalizes the repo full name", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const { repositoryId, repositoryFullName } =
        await seedRepo(organizationId);

      const result = await branchService.upsertBranchArtifact({
        organizationId,
        repositoryId,
        // Deliberately pass a MixedCase/`.git` name: the write path must
        // normalize it into the stored D2 key column.
        repositoryFullName: `${repositoryFullName}.git`,
        branchName: "feature/org-invariant",
        projectId,
      });
      expect(result.ok).toBe(true);

      const branch = await withDb((db) =>
        db.branchDetail.findFirst({
          where: { organizationId, branchName: "feature/org-invariant" },
          include: { artifact: { select: { organizationId: true } } },
        })
      );
      expect(branch).not.toBeNull();
      // FR13: the denormalized copy equals the parent Artifact's org (the SSOT).
      expect(branch?.organizationId).toBe(organizationId);
      expect(branch?.organizationId).toBe(branch?.artifact.organizationId);
      // D2: the stored full name is normalized (lowercase, no trailing `.git`).
      expect(branch?.repositoryFullName).toBe(repositoryFullName.toLowerCase());
    });
  });

  it("holds branch_detail.organization_id = artifacts.organization_id across every row in the org", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const { repositoryId, repositoryFullName } =
        await seedRepo(organizationId);

      for (const branchName of ["feature/a", "feature/b", "feature/c"]) {
        const result = await branchService.upsertBranchArtifact({
          organizationId,
          repositoryId,
          repositoryFullName,
          branchName,
          projectId,
        });
        expect(result.ok).toBe(true);
      }

      // Scan every branch artifact in the org and assert no org drift on any row.
      const rows = await withDb((db) =>
        db.artifact.findMany({
          where: { organizationId, type: ArtifactType.BRANCH },
          select: {
            organizationId: true,
            branch: { select: { organizationId: true } },
          },
        })
      );
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(row.branch?.organizationId).toBe(row.organizationId);
      }
    });
  });
});
