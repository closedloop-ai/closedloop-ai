/**
 * ISS-9632 — reconcile artifacts left stale in `BLOCKED`.
 *
 * `BLOCKS` edges carried no status semantics until ISS-9632, so a dependent
 * whose blocker went terminal was never moved and has been sitting in `BLOCKED`
 * ever since. Those rows are invisible to everything that reads `TODO`, so the
 * work behind them stopped without any signal. The forward path fixes new
 * transitions; this sweep clears the ones already accumulated.
 *
 * Idempotent and safe to re-run: it only ever considers rows that are STILL
 * `BLOCKED` and that have at least one inbound `BLOCKS` edge whose sources are
 * all terminal, so a second run over a reconciled org moves nothing.
 *
 * Usage:
 *   cd apps/api
 *   # report only, change nothing (default):
 *   DATABASE_URL=<url> npx tsx scripts/reconcile-stale-blocked-artifacts.ts
 *   # one organization:
 *   DATABASE_URL=<url> ORG_ID=<uuid> npx tsx scripts/reconcile-stale-blocked-artifacts.ts
 *   # actually write:
 *   APPLY=1 DATABASE_URL=<url> npx tsx scripts/reconcile-stale-blocked-artifacts.ts
 */
import { fileURLToPath } from "node:url";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { BLOCKED_STATUS } from "../app/documents/blocked-dependent-resolution";
import {
  blockedDependentUnblockService,
  type ReconcileOutcome,
} from "../app/documents/blocked-dependent-unblock-service";
import { type ScriptOutput, scriptOutput } from "./script-progress-output";

/** Every organization that currently holds at least one `BLOCKED` artifact. */
export async function organizationsWithBlockedArtifacts(): Promise<string[]> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { type: ArtifactType.Document, status: BLOCKED_STATUS },
      select: { organizationId: true },
      distinct: ["organizationId"],
      orderBy: { organizationId: "asc" },
    })
  );
  return rows.map((row) => row.organizationId);
}

/**
 * Run the sweep (or the read-only preview) across the requested organizations
 * and report per org. Reporting, not silent mutation, is the point: the count
 * of rows this moves is the evidence that the defect was real.
 *
 * Preview reports `resolvedIds` (nothing was written, so `unblockedIds` is
 * empty); apply reports `unblockedIds`, the rows the write actually landed —
 * never `resolvedIds`, which can exceed it when a concurrent write moved a row
 * out of `BLOCKED` and the update's guard declined it. A backfill report that
 * overstates what it moved is worse than no report.
 */
export async function runReconciliation(params: {
  organizationIds: readonly string[];
  apply: boolean;
  output: ScriptOutput;
}): Promise<ReconcileOutcome[]> {
  const rows: ReconcileOutcome[] = [];
  for (const organizationId of params.organizationIds) {
    const outcome = params.apply
      ? await blockedDependentUnblockService.reconcileStaleBlockedArtifacts({
          organizationId,
        })
      : await blockedDependentUnblockService.previewStaleBlockedArtifacts({
          organizationId,
        });
    rows.push(outcome);

    const moved = movedIds(outcome, params.apply);
    await params.output.log(
      `${organizationId}: scanned ${outcome.scanned} BLOCKED, ${verb(
        params.apply
      )} ${moved.length}${moved.length > 0 ? ` — ${moved.join(", ")}` : ""}`
    );
    if (
      params.apply &&
      outcome.unblockedIds.length !== outcome.resolvedIds.length
    ) {
      await params.output.warn(
        `${organizationId}: ${outcome.resolvedIds.length - outcome.unblockedIds.length} resolved row(s) were NOT written — a concurrent write moved them out of BLOCKED first. Re-run to reconcile.`
      );
    }
  }

  const totalScanned = rows.reduce((sum, row) => sum + row.scanned, 0);
  const totalMoved = rows.reduce(
    (sum, row) => sum + movedIds(row, params.apply).length,
    0
  );
  await params.output.log(
    `TOTAL: ${rows.length} org(s), scanned ${totalScanned}, ${verb(
      params.apply
    )} ${totalMoved}`
  );
  return rows;
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1";
  const orgId = process.env.ORG_ID;
  const organizationIds = orgId
    ? [orgId]
    : await organizationsWithBlockedArtifacts();

  if (!apply) {
    await scriptOutput.log(
      "PREVIEW MODE — nothing will be written. Re-run with APPLY=1 to apply."
    );
  }
  await runReconciliation({ organizationIds, apply, output: scriptOutput });
}

/**
 * What a run may honestly claim it moved: the written set when applying, the
 * would-move set when previewing.
 */
function movedIds(outcome: ReconcileOutcome, apply: boolean): string[] {
  return apply ? outcome.unblockedIds : outcome.resolvedIds;
}

function verb(apply: boolean): string {
  return apply ? "unblocked" : "would unblock";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    scriptOutput.error(error);
    process.exitCode = 1;
  });
}
