import { encodeBranchId } from "@repo/api/src/types/branch";
import { BRANCH_LIST_COMPLETE_COHORT_MAX_ROWS } from "@repo/api/src/types/branch-list-work-budget";
import { z } from "zod";
import { normalizeBranchActivityScopes } from "./branch-activity-identity.js";
import { queryBranchActivityRowsWithReader } from "./branch-activity-query.js";
import type { BranchCanonicalActivityRow } from "./branch-activity-read.js";
import {
  type BranchCommitRow,
  type BranchLinkRow,
  type BranchPrRow,
  readBranchTokenAggregateRows,
  readLocalBranchCommitRows,
  readLocalBranchLinkRows,
  readLocalBranchPrRows,
  readSessionBranchCounts,
} from "./branch-reads.js";
import type { BranchTokenAggregateRow } from "./branch-token-aggregate-reads.js";
import type { DesktopPrisma } from "./prisma-client.js";

export const branchListSnapshotRequestSchema = z
  .object({
    eligibleBranchIds: z
      .array(z.string().min(1))
      .max(BRANCH_LIST_COMPLETE_COHORT_MAX_ROWS),
    denominatorEligibleBranchIds: z
      .array(z.string().min(1))
      .max(BRANCH_LIST_COMPLETE_COHORT_MAX_ROWS),
  })
  .strict();

export type BranchListSnapshotRequest = z.infer<
  typeof branchListSnapshotRequestSchema
>;

export type BranchListSnapshot = {
  linkRows: BranchLinkRow[];
  prRows: BranchPrRow[];
  commitRows: BranchCommitRow[];
  tokenRows: BranchTokenAggregateRow[];
  activityRows: BranchCanonicalActivityRow[];
  sessionBranchCountEntries: [string, number][];
};

const branchListSnapshotEnvelopeSchema = z
  .object({
    linkRows: z.array(z.unknown()),
    prRows: z.array(z.unknown()),
    commitRows: z.array(z.unknown()),
    tokenRows: z.array(z.unknown()),
    activityRows: z.array(z.unknown()),
    sessionBranchCountEntries: z.array(
      z.tuple([z.string(), z.number().int().min(1)])
    ),
  })
  .strict();

/** Validate the strict cross-process envelope after row-level DB mapping. */
export function parseBranchListSnapshot(value: unknown): BranchListSnapshot {
  return branchListSnapshotEnvelopeSchema.parse(value) as BranchListSnapshot;
}

/** Read every list-envelope input from one committed SQLite snapshot. */
export function readBranchListSnapshot(
  prisma: DesktopPrisma,
  request: BranchListSnapshotRequest
) {
  const parsed = branchListSnapshotRequestSchema.parse(request);
  return prisma.read((reader) =>
    reader.$transaction(async (transaction) => {
      const scopedPrisma = { client: transaction };
      const linkRows = await readLocalBranchLinkRows(scopedPrisma);
      const eligibleKeys = selectAllowedBranchKeys(
        linkRows,
        parsed.eligibleBranchIds
      );
      const denominatorKeys = selectAllowedBranchKeys(
        linkRows,
        parsed.denominatorEligibleBranchIds
      );
      const eligibleSessionIds = selectAllowedSessionIds(
        linkRows,
        parsed.eligibleBranchIds
      );
      const [prRows, commitRows, tokenRows, activityRows, sessionBranchCounts] =
        await Promise.all([
          readLocalBranchPrRows(scopedPrisma),
          readLocalBranchCommitRows(scopedPrisma),
          readBranchTokenAggregateRows(
            scopedPrisma,
            eligibleKeys,
            denominatorKeys
          ),
          queryBranchActivityRowsWithReader(
            transaction,
            normalizeBranchActivityScopes(eligibleKeys)
          ),
          readSessionBranchCounts(
            scopedPrisma,
            eligibleSessionIds,
            denominatorKeys
          ),
        ]);
      return {
        linkRows,
        prRows,
        commitRows,
        tokenRows,
        activityRows,
        sessionBranchCountEntries: [...sessionBranchCounts],
      };
    })
  );
}

function selectAllowedBranchKeys(
  rows: readonly BranchLinkRow[],
  allowedBranchIds: readonly string[]
): Array<{ repoFullName: string | null; branchName: string }> {
  const allowed = new Set(allowedBranchIds);
  const selected = new Map<
    string,
    { repoFullName: string | null; branchName: string }
  >();
  for (const row of rows) {
    const id = encodeBranchId(row);
    if (allowed.has(id)) {
      selected.set(id, {
        repoFullName: row.repoFullName,
        branchName: row.branchName,
      });
    }
  }
  return [...selected.values()];
}

function selectAllowedSessionIds(
  rows: readonly BranchLinkRow[],
  allowedBranchIds: readonly string[]
): string[] {
  const allowed = new Set(allowedBranchIds);
  return [
    ...new Set(
      rows
        .filter((row) => allowed.has(encodeBranchId(row)))
        .map((row) => row.sessionId)
    ),
  ].sort();
}
