import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);

describe.skipIf(!hasDatabase)(
  "Branch product eligibility projection (real Postgres)",
  () => {
    it("uses the canonical SQL and excludes branches outside the organization", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const otherOrganizationId = await createTestOrganization();
        const branchId = await seedBranch(organizationId, "feature-branch");
        const otherBranchId = await seedBranch(
          otherOrganizationId,
          "other-feature-branch"
        );

        const result = await branchProductEligibilityService.findByIds(
          organizationId,
          [branchId, otherBranchId]
        );

        expect(result).toEqual(
          new Map([[branchId, BranchProductEligibility.Ineligible]])
        );
      });
    });
  }
);

async function seedBranch(organizationId: string, branchName: string) {
  const branch = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: BranchStatus.Open,
        branch: {
          create: {
            organizationId,
            repositoryFullName: "example/repository",
            branchName,
          },
        },
      },
      select: { id: true },
    })
  );
  return branch.id;
}
