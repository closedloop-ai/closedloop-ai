import type { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { normalizeBranchActivityScopes } from "./branch-activity-identity.js";
import { queryBranchActivityRows } from "./branch-activity-query.js";
import { reconcileBranchActivityRows } from "./branch-activity-reconciliation.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Exact persisted Branch identity accepted by the canonical activity read. */
export type BranchCanonicalActivityKey = {
  repoFullName: string | null;
  branchName: string;
};

/** Eligible Branch corpus that bounds one canonical activity read. */
export type BranchCanonicalActivityReadRequest = {
  branchKeys: readonly BranchCanonicalActivityKey[];
};

/** Latest validated monitored-session evidence for one exact persisted Branch. */
export type BranchCanonicalActivityRow = BranchCanonicalActivityKey & {
  sourceEventId: string;
  occurredAt: string | null;
  completeness: BranchActivityEvidenceCompleteness;
};

/** Clone-safe Branch activity operation exposed through the Desktop DB host. */
export type BranchCanonicalActivityReadMethods = {
  readBranchCanonicalActivityRows(
    request: BranchCanonicalActivityReadRequest
  ): Promise<BranchCanonicalActivityRow[]>;
};

/** Build the bounded canonical Branch activity database operation. */
export function createBranchCanonicalActivityReadMethods(
  prisma: DesktopPrisma
): BranchCanonicalActivityReadMethods {
  return {
    readBranchCanonicalActivityRows: async ({ branchKeys }) => {
      const scopes = normalizeBranchActivityScopes(branchKeys);
      if (scopes.length === 0) {
        return [];
      }
      const rawRows = await queryBranchActivityRows(prisma, scopes);
      return reconcileBranchActivityRows(rawRows);
    },
  };
}
