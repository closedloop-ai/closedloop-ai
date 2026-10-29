/**
 * Deleting a vibe environment's S3 objects with its schema (ISS-12056).
 *
 * A private internal of `app/preview-schemas/service.ts`. A vibe environment
 * writes every object under `vibe-environments/<schema>/` in stage's shared
 * buckets (the keyspace prefix in `@repo/aws`), so those objects are deleted
 * by that prefix: right after a branch's schema is dropped, and by the daily
 * sweep for any prefix whose schema no longer exists, which also collects what
 * a failed or capped deletion and any other drop path left behind.
 *
 * Runs on stage, whose client has no keyspace prefix, so the prefixes here are
 * the real keys. An S3 failure is logged and counted; it never turns a
 * completed DROP into a failed one.
 */

import { deleteObjects, listCommonPrefixes, listObjects } from "@repo/aws";
import { config, S3_BATCH_DELETE_MAX_KEYS } from "@repo/aws/s3-client";
import { Prisma, withDb } from "@repo/database";
import type { CategoryCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  buildSummary,
  computeExitCode,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  schemaOfVibeEnvironmentKey,
  VIBE_ENVIRONMENT_KEY_ROOT,
  vibeEnvironmentKeyPrefix,
} from "@repo/database/scripts/vibe-environment";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { DropBudget } from "./drop-budget";

export type VibeObjectCleanupReport = {
  /** Objects deleted. */
  deleted: number;
  /** Bucket prefixes left empty. */
  cleared: number;
  /** Bucket prefix listings or deletions that hit their page cap. */
  truncated: number;
  /** Bucket prefixes whose listing or deletion failed. */
  errored: number;
  /** Orphaned prefixes the sweep found but left for the next run. */
  deferred: number;
};

/** Pages of up to 1,000 keys deleted per bucket prefix in one call. */
export const VIBE_OBJECT_PAGES_PER_PREFIX = 10;
/** Orphaned bucket prefixes one sweep deletes; the rest wait for the next. */
export const VIBE_ORPHAN_PREFIXES_PER_SWEEP = 25;
/** Pages of prefix listing read per bucket when looking for orphans. */
export const VIBE_PREFIX_LISTING_PAGES = 5;

export function emptyVibeObjectCleanupReport(): VibeObjectCleanupReport {
  return { deleted: 0, cleared: 0, truncated: 0, errored: 0, deferred: 0 };
}

/**
 * The sweep's summary line and exit code, with the object report beside the
 * schema counters. Failed or incomplete S3 cleanup fails the exit code like a
 * failed DROP, so objects left in stage's buckets cannot go unnoticed.
 */
export function summarizeSweep(
  counters: CategoryCounters,
  report: VibeObjectCleanupReport
): { summary: string; exitCode: 0 | 1 } {
  const summary =
    `${buildSummary(counters)} vibe-objects[deleted=${report.deleted} ` +
    `cleared=${report.cleared} truncated=${report.truncated} ` +
    `errored=${report.errored} deferred=${report.deferred}]`;
  const exitCode =
    computeExitCode(counters) === 1 ||
    report.errored > 0 ||
    report.truncated > 0 ||
    report.deferred > 0
      ? 1
      : 0;
  return { summary, exitCode };
}

/** Deletes every object under a dropped schema's prefix in every bucket. */
export async function deleteVibeEnvironmentObjects(
  schemaName: string
): Promise<VibeObjectCleanupReport> {
  const report = emptyVibeObjectCleanupReport();
  const prefix = vibeEnvironmentKeyPrefix(schemaName);
  for (const bucket of vibeObjectBuckets()) {
    await clearBucketPrefix(bucket, prefix, report);
  }
  return report;
}

/**
 * Deletes the objects of every `vibe-environments/<schema>/` prefix whose
 * schema is gone from `pg_namespace`, bounded per run and by the sweep budget.
 */
export async function sweepOrphanedVibeObjects(
  budget: DropBudget
): Promise<VibeObjectCleanupReport> {
  const report = emptyVibeObjectCleanupReport();
  let remaining = VIBE_ORPHAN_PREFIXES_PER_SWEEP;
  for (const bucket of vibeObjectBuckets()) {
    const orphans = await findOrphanedPrefixes(bucket, report);
    for (const prefix of orphans) {
      if (remaining === 0 || budget.isExhausted()) {
        report.deferred += 1;
        continue;
      }
      remaining -= 1;
      await clearBucketPrefix(bucket, prefix, report);
    }
  }
  if (
    report.errored > 0 ||
    report.deferred > 0 ||
    report.truncated > 0 ||
    report.cleared > 0
  ) {
    log.info(
      "[preview-schema-cleanup] Swept orphaned vibe environment objects",
      {
        ...report,
      }
    );
  }
  return report;
}

/** Every configured bucket a vibe environment can write to, once each. */
function vibeObjectBuckets(): string[] {
  const buckets = [
    config.TRANSCRIPTS_BUCKET,
    config.FILE_ATTACHMENTS_BUCKET,
    config.PLUGIN_STORE_BUCKET,
  ].filter((bucket): bucket is string => bucket !== undefined);
  return [...new Set(buckets)];
}

async function clearBucketPrefix(
  bucket: string,
  prefix: string,
  report: VibeObjectCleanupReport
): Promise<void> {
  try {
    let continuationToken: string | undefined;
    for (let page = 0; page < VIBE_OBJECT_PAGES_PER_PREFIX; page++) {
      const listed = await listObjects({
        bucket,
        prefix,
        continuationToken,
        maxKeys: S3_BATCH_DELETE_MAX_KEYS,
      });
      await deleteObjects(
        listed.objects.map((object) => object.key),
        bucket
      );
      report.deleted += listed.objects.length;
      continuationToken = listed.nextContinuationToken;
      if (continuationToken === undefined) {
        report.cleared += 1;
        return;
      }
    }
    report.truncated += 1;
  } catch (err) {
    report.errored += 1;
    log.error(
      "[preview-schema-cleanup] Failed to delete vibe environment objects",
      { bucket, prefix, error: parseError(err) }
    );
  }
}

/**
 * The `vibe-environments/<schema>/` prefixes in `bucket` whose schema does not
 * exist. A listing or lookup failure counts as one errored prefix and answers
 * none, so nothing is deleted on a guess.
 */
async function findOrphanedPrefixes(
  bucket: string,
  report: VibeObjectCleanupReport
): Promise<string[]> {
  try {
    const bySchema = new Map<string, string>();
    let continuationToken: string | undefined;
    for (let page = 0; page < VIBE_PREFIX_LISTING_PAGES; page++) {
      const listed = await listCommonPrefixes({
        bucket,
        prefix: VIBE_ENVIRONMENT_KEY_ROOT,
        continuationToken,
      });
      for (const prefix of listed.prefixes) {
        const schema = schemaOfVibeEnvironmentKey(prefix);
        if (schema !== null && prefix === vibeEnvironmentKeyPrefix(schema)) {
          bySchema.set(schema, prefix);
        }
      }
      continuationToken = listed.nextContinuationToken;
      if (continuationToken === undefined) {
        break;
      }
    }
    if (continuationToken !== undefined) {
      report.truncated += 1;
    }
    const existing = await existingSchemas([...bySchema.keys()]);
    return [...bySchema]
      .filter(([schema]) => !existing.has(schema))
      .map(([, prefix]) => prefix);
  } catch (err) {
    report.errored += 1;
    log.error(
      "[preview-schema-cleanup] Failed to find orphaned vibe environment objects",
      { bucket, error: parseError(err) }
    );
    return [];
  }
}

async function existingSchemas(schemaNames: string[]): Promise<Set<string>> {
  if (schemaNames.length === 0) {
    return new Set();
  }
  const rows = await withDb((db) =>
    db.$queryRaw<{ nspname: string }[]>(Prisma.sql`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname = ANY(${schemaNames})
    `)
  );
  return new Set(rows.map((row) => row.nspname));
}
