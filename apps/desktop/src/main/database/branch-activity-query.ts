import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { compareMonitoredActivityIdentities } from "@repo/api/src/types/session-monitored-activity";
import { syncTimestampSchema } from "@repo/api/src/types/sync-timestamp";
import { z } from "zod";
import { BRANCH_ACTIVITY_FAST_PATH_SQL } from "./branch-activity-fast-path-sql.js";
import {
  branchActivityLookupKey,
  type NormalizedBranchActivityScope,
  normalizeActivityBranchName,
  normalizeActivityRepository,
} from "./branch-activity-identity.js";
import {
  BRANCH_ACTIVITY_CARRIER_EXISTS_SQL,
  BRANCH_ACTIVITY_READ_SQL,
  BRANCH_ACTIVITY_SCOPE_BATCH_SIZE,
} from "./branch-activity-sql.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";

/** Final payload-free row returned by the canonical SQLite activity query. */
export type BranchActivityQueryRow = {
  repoFullName: string;
  branchName: string;
  sourceEventId: string;
  occurredAt: string | null;
  completeness: BranchActivityEvidenceCompleteness;
};

type BranchActivityCarrierExistsRow = {
  hasCarrier: boolean | number | bigint | string | null;
};

type BranchActivityFastPathRow = {
  fastPathSupported: boolean | number | bigint | string | null;
  repoFullName: unknown;
  branchName: unknown;
  sourceEventId: unknown;
  occurredAt: unknown;
  completeness: unknown;
};

/**
 * Reconcile the eligible activity corpus inside SQLite and retain independently
 * valid final rows at the database-to-JavaScript trust boundary.
 */
export function queryBranchActivityRows(
  prisma: DesktopPrisma,
  scopes: readonly NormalizedBranchActivityScope[]
): Promise<BranchActivityQueryRow[]> {
  const validScopes = normalizeQueryScopes(scopes);
  if (validScopes.length === 0) {
    return Promise.resolve([]);
  }
  return prisma.read((reader) =>
    queryBranchActivityRowsWithReader(reader, validScopes)
  );
}

/** Run the canonical activity read on an already pinned read transaction. */
export async function queryBranchActivityRowsWithReader(
  reader: DesktopPrismaReader,
  scopes: readonly NormalizedBranchActivityScope[]
): Promise<BranchActivityQueryRow[]> {
  const validScopes = normalizeQueryScopes(scopes);
  if (validScopes.length === 0) {
    return [];
  }
  if (
    shouldRunGlobalCarrierPreflight(validScopes) &&
    !(await hasBranchActivityCarriers(reader))
  ) {
    return [];
  }
  const fastPathRows = await queryFastPathBranchActivityRows(
    reader,
    validScopes
  );
  if (fastPathRows) {
    return fastPathRows;
  }
  const rawRows = await reader.$queryRawUnsafe<unknown>(
    BRANCH_ACTIVITY_READ_SQL,
    JSON.stringify(batchQueryScopes(validScopes))
  );
  return parseBranchActivityRows(rawRows, validScopes).sort(
    compareBranchActivityQueryRows
  );
}

async function queryFastPathBranchActivityRows(
  reader: DesktopPrismaReader,
  scopes: readonly NormalizedBranchActivityScope[]
): Promise<BranchActivityQueryRow[] | null> {
  const rawRows = await reader.$queryRawUnsafe<unknown>(
    BRANCH_ACTIVITY_FAST_PATH_SQL,
    JSON.stringify(batchQueryScopes(scopes))
  );
  return parseFastPathBranchActivityRows(rawRows, scopes);
}

function shouldRunGlobalCarrierPreflight(
  scopes: readonly NormalizedBranchActivityScope[]
): boolean {
  return scopes.length > BRANCH_ACTIVITY_SCOPE_BATCH_SIZE;
}

async function hasBranchActivityCarriers(
  reader: DesktopPrismaReader
): Promise<boolean> {
  const rows = await reader.$queryRawUnsafe<BranchActivityCarrierExistsRow[]>(
    BRANCH_ACTIVITY_CARRIER_EXISTS_SQL
  );
  const hasCarrier = rows[0]?.hasCarrier;
  return (
    hasCarrier === true ||
    hasCarrier === 1 ||
    hasCarrier === 1n ||
    hasCarrier === "1"
  );
}

function parseFastPathBranchActivityRows(
  rows: unknown,
  scopes: readonly NormalizedBranchActivityScope[]
): BranchActivityQueryRow[] | null {
  const envelope = z.array(branchActivityFastPathRowSchema).safeParse(rows);
  if (!envelope.success || envelope.data.length === 0) {
    return null;
  }
  if (
    envelope.data.some((row) => !isFastPathSupported(row.fastPathSupported))
  ) {
    return null;
  }
  const candidateRows = envelope.data.flatMap((row) => {
    if (
      row.repoFullName === null &&
      row.branchName === null &&
      row.sourceEventId === null &&
      row.occurredAt === null
    ) {
      return [];
    }
    return [
      {
        repoFullName: row.repoFullName,
        branchName: row.branchName,
        sourceEventId: row.sourceEventId,
        occurredAt: row.occurredAt,
        completeness: row.completeness,
      },
    ];
  });
  const parsedRows = parseBranchActivityRows(candidateRows, scopes);
  return parsedRows.length === candidateRows.length
    ? parsedRows.sort(compareBranchActivityQueryRows)
    : null;
}

function parseBranchActivityRows(
  rows: unknown,
  scopes: readonly NormalizedBranchActivityScope[]
): BranchActivityQueryRow[] {
  const envelope = z.array(z.unknown()).safeParse(rows);
  if (!envelope.success) {
    return [];
  }
  const allowedKeys = new Set(scopes.map(branchActivityLookupKey));
  const parsedRows = envelope.data.flatMap((row) => {
    const parsed = branchActivityQueryRowSchema.safeParse(row);
    if (!parsed.success) {
      return [];
    }
    const repoFullName = normalizeActivityRepository(parsed.data.repoFullName);
    const branchName = normalizeActivityBranchName(parsed.data.branchName);
    if (!(repoFullName && branchName)) {
      return [];
    }
    const key = branchActivityLookupKey({ repoFullName, branchName });
    return allowedKeys.has(key) ? [{ key, row: parsed.data }] : [];
  });
  const keyCounts = new Map<string, number>();
  for (const parsed of parsedRows) {
    keyCounts.set(parsed.key, (keyCounts.get(parsed.key) ?? 0) + 1);
  }
  return parsedRows.flatMap(({ key, row }) =>
    keyCounts.get(key) === 1 ? [row] : []
  );
}

const branchActivityFastPathRowSchema = z
  .object({
    fastPathSupported: z.union([
      z.boolean(),
      z.number(),
      z.bigint(),
      z.string(),
    ]),
    repoFullName: z.unknown().nullable(),
    branchName: z.unknown().nullable(),
    sourceEventId: z.unknown().nullable(),
    occurredAt: z.unknown().nullable(),
    completeness: z.unknown().nullable(),
  })
  .strict();

const branchActivityQueryRowSchema = z
  .object({
    repoFullName: z.string().refine((value) => value.trim().length > 0),
    branchName: z.string().refine((value) => value.trim().length > 0),
    sourceEventId: z.string().refine((value) => value.trim().length > 0),
    occurredAt: syncTimestampSchema.nullable(),
    completeness: z.enum(BranchActivityEvidenceCompleteness),
  })
  .strict()
  .refine(
    (row) =>
      row.occurredAt !== null ||
      row.completeness === BranchActivityEvidenceCompleteness.Partial
  );

function normalizeQueryScopes(
  scopes: readonly NormalizedBranchActivityScope[]
): NormalizedBranchActivityScope[] {
  const normalized = new Map<string, NormalizedBranchActivityScope>();
  for (const scope of scopes) {
    const repoFullName = normalizeActivityRepository(scope.repoFullName);
    const branchName = normalizeActivityBranchName(scope.branchName);
    if (!(repoFullName && branchName)) {
      continue;
    }
    const candidate = { repoFullName, branchName };
    normalized.set(branchActivityLookupKey(candidate), candidate);
  }
  return [...normalized.values()];
}

function isFastPathSupported(
  value: BranchActivityFastPathRow["fastPathSupported"]
): boolean {
  return value === true || value === 1 || value === 1n || value === "1";
}

function batchQueryScopes(
  scopes: readonly NormalizedBranchActivityScope[]
): NormalizedBranchActivityScope[][] {
  const batches: NormalizedBranchActivityScope[][] = [];
  for (
    let offset = 0;
    offset < scopes.length;
    offset += BRANCH_ACTIVITY_SCOPE_BATCH_SIZE
  ) {
    batches.push(
      scopes.slice(offset, offset + BRANCH_ACTIVITY_SCOPE_BATCH_SIZE)
    );
  }
  return batches;
}

function compareBranchActivityQueryRows(
  left: BranchActivityQueryRow,
  right: BranchActivityQueryRow
): number {
  return (
    compareMonitoredActivityIdentities(left.repoFullName, right.repoFullName) ||
    compareMonitoredActivityIdentities(left.branchName, right.branchName) ||
    compareMonitoredActivityIdentities(left.sourceEventId, right.sourceEventId)
  );
}
