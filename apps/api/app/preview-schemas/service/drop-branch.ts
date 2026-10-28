/**
 * Dropping the preview schema that belongs to one git branch (ISS-5985).
 *
 * A private internal of `app/preview-schemas/service.ts`, which stays the only
 * module routes consume — it re-exports `DropResult`. Split out per the
 * nested-service pattern in `apps/api/AGENTS.md` so the composition root does
 * not carry every concern.
 *
 * Distinct from the sweep: this path is entered by NAME, from the cleanup route
 * and from the `pull_request.closed` webhook, so it owns the branch-name bound
 * and the already-absent/dropped distinction. Both share `executeDrop`.
 */

import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { Prisma, withDb } from "@repo/database";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { executeDrop } from "./drop-execution";
import type { VibeObjectCleanupReport } from "./vibe-object-cleanup";
import { deleteVibeEnvironmentObjects } from "./vibe-object-cleanup";

export type DropResult = {
  schemaName: string;
  dropped: boolean;
  alreadyGone: boolean;
  error: string | null;
  /**
   * ISS-12056: the deletion of the schema's vibe environment objects, present
   * only when this call dropped the schema. Its failures never set `error`:
   * the schema is gone either way, and the daily sweep retries the objects.
   */
  vibeObjects?: VibeObjectCleanupReport;
};

/**
 * Drops the preview schema for a specific git branch name.
 *
 * Derives the schema name via `normalizePreviewSchemaName`.
 * `deriveBranchSchemaName` throws if the result does not start with
 * `preview_`; `executeDrop` enforces the same prefix guard.
 *
 * `DROP SCHEMA IF EXISTS` is idempotent. We check `pg_namespace` before
 * dropping so callers can distinguish a fresh drop from an already-absent
 * schema.
 */
export async function dropSchemaForBranch(branch: string): Promise<DropResult> {
  // Validated HERE rather than on the route: the GitHub webhook reaches this
  // function without passing any route validator, and an unshaped branch
  // still derives a `preview_*` name (ISS-7567).
  if (!repoBranchSchema.safeParse(branch).success) {
    log.error("[preview-schema-cleanup] Rejected invalid branch name", {
      branch: branch.slice(0, BRANCH_NAME_MAX_LENGTH),
    });
    return {
      schemaName: "",
      dropped: false,
      alreadyGone: false,
      error: INVALID_BRANCH_NAME_ERROR,
    };
  }

  const schemaName = deriveBranchSchemaName(branch, normalizePreviewSchemaName);

  try {
    // Check existence before DROP to distinguish "dropped" from "already gone"
    const existing = await withDb((db) =>
      db.$queryRaw<{ nspname: string }[]>(Prisma.sql`
          SELECT nspname
          FROM pg_namespace
          WHERE nspname = ${schemaName}
        `)
    );

    if (existing.length === 0) {
      log.info("[preview-schema-cleanup] Schema already absent", {
        schemaName,
        branch,
      });
      return { schemaName, dropped: false, alreadyGone: true, error: null };
    }

    await executeDrop(schemaName);
    log.info("[preview-schema-cleanup] Dropped schema for branch", {
      schemaName,
      branch,
    });
  } catch (err) {
    // Catches both the existence-check query and the executeDrop call so a
    // failure in either surfaces as a structured DropResult.error rather
    // than a thrown exception that callers misinterpret as auth failure.
    const message = parseError(err);
    log.error("[preview-schema-cleanup] Failed to drop schema for branch", {
      schemaName,
      branch,
      error: message,
    });
    return { schemaName, dropped: false, alreadyGone: false, error: message };
  }

  return {
    schemaName,
    dropped: true,
    alreadyGone: false,
    error: null,
    vibeObjects: await deleteVibeEnvironmentObjects(schemaName),
  };
}

/** Returned by `dropSchemaForBranch` when the branch fails `repoBranchSchema`. */
const INVALID_BRANCH_NAME_ERROR = "Invalid branch name";
