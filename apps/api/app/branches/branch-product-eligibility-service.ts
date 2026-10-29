import {
  type BranchProductEligibility,
  BranchProductEligibility as BranchProductEligibilityValue,
} from "@repo/api/src/types/branch-product-eligibility";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { cloudBranchProductEligibilitySql } from "./cloud-branch-eligibility";

/**
 * Bounded Branch eligibility projection shared by relationship/tree readers.
 * Every SQL batch reuses the exact canonical Product predicate.
 */
export const branchProductEligibilityService = {
  async findByIds(
    organizationId: string,
    branchIds: readonly string[]
  ): Promise<ReadonlyMap<string, BranchProductEligibility>> {
    const ids = Array.from(new Set(branchIds));
    if (ids.length === 0) {
      return new Map();
    }

    try {
      const eligibilityById = new Map<string, BranchProductEligibility>();
      for (const batch of chunks(ids, BRANCH_PRODUCT_ELIGIBILITY_BATCH_SIZE)) {
        const rows = await withDb((db) =>
          db.$queryRaw<BranchEligibilityRow[]>(Prisma.sql`
            SELECT
              a.id,
              ${cloudBranchProductEligibilitySql()} AS eligible
            FROM artifacts a
            INNER JOIN branch_detail b ON b.artifact_id = a.id
            WHERE a.organization_id = ${organizationId}::uuid
              AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
              AND a.id IN (${Prisma.join(
                batch.map((id) => Prisma.sql`${id}::uuid`)
              )})
          `)
        );
        for (const row of rows) {
          eligibilityById.set(
            row.id,
            row.eligible
              ? BranchProductEligibilityValue.Eligible
              : BranchProductEligibilityValue.Ineligible
          );
        }
      }
      return eligibilityById;
    } catch (error) {
      // This event is already monitored for best-effort enrichment failures.
      // Returning no classifications makes every consumer omit the optional
      // field and therefore render truthful non-links instead of stale links.
      log.warn("telemetry.enrichment_failed", {
        enrichmentKind: "branch_product_eligibility",
        errorClass:
          error instanceof Error ? error.constructor.name : "UnknownError",
        requestedBranchCount: ids.length,
      });
      return new Map();
    }
  },
};

type BranchEligibilityRow = { eligible: boolean; id: string };

const BRANCH_PRODUCT_ELIGIBILITY_BATCH_SIZE = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
