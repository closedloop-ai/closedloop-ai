import { headAttachmentObject, headAttachmentsBucket } from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { getSafeAttachmentStorageErrorMessage } from "./attachment-storage-key-redaction";
import { ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS } from "./attachments-service";

/** `fileAttachment` rows read per discovery page. Also the write batch size. */
const ROW_PAGE_SIZE = 200;

/**
 * Max rows walked by the discovery phase per run (the confirm phase is bounded
 * separately, by the deletion cap). Each candidate row costs one HeadObject, so
 * this bounds both the S3 call volume and the wall clock of a single sweep; a
 * large backlog converges across nightly runs instead of one oversized pass.
 */
const MAX_ROWS_SCANNED_PER_RUN = 2000;

/**
 * Max rows deleted per run. Caps the blast radius of any single sweep — a bug
 * that made every object look absent can still only remove this many rows
 * before the run stops and reports.
 */
const MAX_DELETIONS_PER_RUN = 500;

/**
 * Minimum age of the FIRST absence observation before the second one may delete
 * the row.
 *
 * The two observations are what close the upload race: a presigned PUT's expiry
 * gates when the transfer may START, not how long it may run, so an upload begun
 * just under the wire is legitimately still in flight — and HeadObject returns
 * 404 for that whole window — after the URL has lapsed. Requiring a second,
 * later observation means an upload that was mid-transfer during the first one
 * has landed (and cleared its mark) before deletion is ever considered.
 *
 * The gap is a floor, not the expected spacing: the sweep runs nightly, so in
 * practice the two observations are ~24h apart. One hour is simply more than any
 * attachment PUT can survive — `MAX_ATTACHMENT_FILE_SIZE_BYTES` caps an
 * attachment at 10 MB, which completes in under an hour at any throughput that
 * would not have already timed out the connection.
 */
const MIN_ABSENCE_CONFIRMATION_GAP_SECONDS = 3600;

export type AttachmentRowReconcileResult = {
  summary: string;
  /** Candidate rows (older than the upload window) HeadObject-checked this run. */
  scanned: number;
  /** Rows observed absent for the FIRST time and marked. Never deleted here. */
  newlyAbsent: number;
  /** Rows observed absent again, a previous run having marked them. */
  orphansConfirmed: number;
  /** Rows actually deleted. Always 0 in dry-run mode. */
  orphansDeleted: number;
  /** Marked rows whose object turned out to exist; their mark was cleared. */
  recovered: number;
  /**
   * Rows whose S3 state could not be determined (throttle, timeout, permission
   * error, 5xx). Never deleted, and reconsidered on a later run.
   */
  ambiguous: number;
  /**
   * True when a per-run cap stopped the sweep with candidates left over, so
   * these counts describe a PARTIAL survey rather than the whole table.
   */
  truncated: boolean;
  dryRun: boolean;
  exitCode: 0 | 1;
};

export type AttachmentRowReconcileOptions = {
  now?: Date;
  /**
   * Arms deletion. Defaults to false — the sweep reports the blast radius it
   * WOULD delete before it is ever allowed to delete anything.
   */
  apply?: boolean;
  maxDeletions?: number;
  maxRowsScanned?: number;
};

type CandidateRow = { id: string; key: string };

const HeadOutcome = {
  Absent: "absent",
  Present: "present",
  Ambiguous: "ambiguous",
} as const;
type HeadOutcome = (typeof HeadOutcome)[keyof typeof HeadOutcome];

type SweepTotals = {
  scanned: number;
  newlyAbsent: number;
  orphansConfirmed: number;
  orphansDeleted: number;
  recovered: number;
  ambiguous: number;
  truncated: boolean;
  firstAmbiguousError?: string;
};

type PhaseContext = {
  bucket: string;
  /** Rows created at or after this instant are never candidates. */
  cutoff: Date;
  /** An absence mark older than this instant may be confirmed for deletion. */
  confirmBefore: Date;
  now: Date;
  dryRun: boolean;
  maxDeletions: number;
  maxRowsScanned: number;
};

/** Clamps an optional caller-supplied bound to a positive integer. */
function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Resolves one row's S3 object state.
 *
 * `headAttachmentObject` returns null ONLY on an authoritative 404 for that key;
 * anything else throws. A throw is therefore `Ambiguous` and the row is left
 * alone — an S3 outage, throttle, or credential problem is not evidence that an
 * object is missing, and treating it as such would delete live data.
 */
async function classifyRow(
  row: CandidateRow,
  bucket: string
): Promise<{ outcome: HeadOutcome; error?: string }> {
  try {
    const head = await headAttachmentObject(row.key, bucket);
    return {
      outcome: head === null ? HeadOutcome.Absent : HeadOutcome.Present,
    };
  } catch (error) {
    return {
      outcome: HeadOutcome.Ambiguous,
      error: getSafeAttachmentStorageErrorMessage(error),
    };
  }
}

/**
 * Reads rows a PREVIOUS run marked absent and that are now old enough to
 * confirm. Ordered by `reconciledAt` so the longest-standing marks are settled
 * first, and read in one bounded query — the deletion cap is the page size, so
 * there is no cursor to invalidate when the rows are deleted underneath it.
 */
function findMarkedRows(
  context: PhaseContext,
  take: number
): Promise<CandidateRow[]> {
  return withDb((db) =>
    db.fileAttachment.findMany({
      where: {
        bucket: context.bucket,
        createdAt: { lt: context.cutoff },
        reconcileAbsent: true,
        reconciledAt: { lt: context.confirmBefore },
      },
      select: { id: true, key: true },
      orderBy: [{ reconciledAt: "asc" }, { id: "asc" }],
      take,
    })
  );
}

/**
 * Reads one page of never-marked rows, least-recently-reconciled first.
 *
 * `reconciledAt` is the work queue, which is what makes the sweep reach the
 * whole table: every examined row is stamped with `now`, so it leaves this
 * page's result set AND sorts behind everything not yet examined. Within a run
 * that advances the loop without a cursor (nothing can invalidate it), and
 * across runs it wraps naturally once every row has been examined once.
 *
 * `createdAt < cutoff` is applied here, at selection time: a row created after
 * this read can never enter the page, and therefore can never be marked or
 * deleted by it.
 */
function findUnmarkedPage(
  context: PhaseContext,
  take: number
): Promise<CandidateRow[]> {
  return withDb((db) =>
    db.fileAttachment.findMany({
      where: {
        bucket: context.bucket,
        createdAt: { lt: context.cutoff },
        reconcileAbsent: false,
        reconciledAt: { lt: context.now },
      },
      select: { id: true, key: true },
      orderBy: [{ reconciledAt: "asc" }, { id: "asc" }],
      take,
    })
  );
}

/**
 * Records this run's determination for a batch of rows.
 *
 * Runs in dry-run mode too: this is the sweep's own bookkeeping, not a deletion.
 * It is what lets a dry run advance through the table across nights and report a
 * real, confirmed blast radius instead of a first-guess one — and a mark is
 * never sufficient on its own, because the confirming run re-checks S3 before
 * deleting anything.
 */
async function stampRows(params: {
  ids: string[];
  reconcileAbsent?: boolean;
  now: Date;
}): Promise<void> {
  const { ids, reconcileAbsent, now } = params;
  if (ids.length === 0) {
    return;
  }
  await withDb((db) =>
    db.fileAttachment.updateMany({
      where: { id: { in: ids } },
      data: {
        reconciledAt: now,
        ...(reconcileAbsent === undefined ? {} : { reconcileAbsent }),
      },
    })
  );
}

/**
 * Deletes a batch confirmed orphaned. Every safety predicate is repeated in the
 * delete itself, so the statement can never widen past what the sweep proved
 * even if the id set were ever built by a different path: past the upload
 * window, still carrying a previous run's absence mark, and that mark old enough
 * to confirm.
 */
async function deleteConfirmedOrphans(
  ids: string[],
  context: PhaseContext
): Promise<number> {
  const result = await withDb((db) =>
    db.fileAttachment.deleteMany({
      where: {
        id: { in: ids },
        createdAt: { lt: context.cutoff },
        reconcileAbsent: true,
        reconciledAt: { lt: context.confirmBefore },
      },
    })
  );
  return result.count;
}

/**
 * Second observation: re-checks rows a previous run marked absent, deletes the
 * ones still absent, and clears the mark on any whose object has since appeared
 * (the in-flight upload landed).
 */
async function runConfirmPhase(
  context: PhaseContext,
  totals: SweepTotals
): Promise<void> {
  // One over the cap, so "there were more than we could take" is observable.
  const candidates = await findMarkedRows(context, context.maxDeletions + 1);
  if (candidates.length > context.maxDeletions) {
    totals.truncated = true;
  }
  const rows = candidates.slice(0, context.maxDeletions);

  const confirmedIds: string[] = [];
  const recoveredIds: string[] = [];

  for (const row of rows) {
    const { outcome, error } = await classifyRow(row, context.bucket);
    totals.scanned += 1;
    if (outcome === HeadOutcome.Absent) {
      confirmedIds.push(row.id);
    } else if (outcome === HeadOutcome.Present) {
      recoveredIds.push(row.id);
    } else {
      totals.ambiguous += 1;
      totals.firstAmbiguousError ??= error;
    }
  }

  totals.orphansConfirmed += confirmedIds.length;
  totals.recovered += recoveredIds.length;

  // Clearing a stale mark is protective, not destructive, so it happens in both
  // modes. An ambiguous row keeps its mark and its old `reconciledAt`, which
  // leaves it at the front of this queue for the next run.
  await stampRows({
    ids: recoveredIds,
    reconcileAbsent: false,
    now: context.now,
  });

  if (context.dryRun || confirmedIds.length === 0) {
    return;
  }
  for (let start = 0; start < confirmedIds.length; start += ROW_PAGE_SIZE) {
    const batch = confirmedIds.slice(start, start + ROW_PAGE_SIZE);
    totals.orphansDeleted += await deleteConfirmedOrphans(batch, context);
  }
}

/**
 * First observation: walks unmarked rows least-recently-reconciled first,
 * marking the ones whose object is absent. Deletes nothing — a row found absent
 * here becomes a candidate for the NEXT run's confirm phase.
 */
async function runDiscoveryPhase(
  context: PhaseContext,
  totals: SweepTotals
): Promise<void> {
  let examined = 0;

  while (examined < context.maxRowsScanned) {
    const take = Math.min(ROW_PAGE_SIZE, context.maxRowsScanned - examined);
    const rows = await findUnmarkedPage(context, take);
    if (rows.length === 0) {
      return;
    }

    const absentIds: string[] = [];
    const presentIds: string[] = [];
    const ambiguousIds: string[] = [];

    for (const row of rows) {
      const { outcome, error } = await classifyRow(row, context.bucket);
      examined += 1;
      totals.scanned += 1;
      if (outcome === HeadOutcome.Absent) {
        absentIds.push(row.id);
      } else if (outcome === HeadOutcome.Present) {
        presentIds.push(row.id);
      } else {
        ambiguousIds.push(row.id);
        totals.ambiguous += 1;
        totals.firstAmbiguousError ??= error;
      }
    }

    totals.newlyAbsent += absentIds.length;

    // Every examined row is stamped, including the ambiguous ones. That is what
    // guarantees the loop makes progress: an unstamped row would come straight
    // back in the next page and the run would spin on it.
    await stampRows({
      ids: absentIds,
      reconcileAbsent: true,
      now: context.now,
    });
    await stampRows({ ids: presentIds, now: context.now });
    await stampRows({ ids: ambiguousIds, now: context.now });
  }

  // Stopped on the cap rather than on an exhausted queue, so this run surveyed
  // only part of the table.
  totals.truncated = true;
}

function buildSummary(totals: SweepTotals, dryRun: boolean): string {
  const action = dryRun
    ? `would delete ${totals.orphansConfirmed} (dry run — no rows removed)`
    : `deleted ${totals.orphansDeleted}`;
  const coverage = totals.truncated
    ? "PARTIAL survey — a per-run cap was reached and candidates remain for the next run"
    : "full survey — no candidates left unexamined";
  return `Scanned ${totals.scanned} attachment row(s) older than ${ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS}s; marked ${totals.newlyAbsent} newly absent, confirmed ${totals.orphansConfirmed} absent on a second run, ${action}; ${totals.recovered} recovered, ${totals.ambiguous} indeterminate and skipped; ${coverage}`;
}

function emptyTotals(): SweepTotals {
  return {
    scanned: 0,
    newlyAbsent: 0,
    orphansConfirmed: 0,
    orphansDeleted: 0,
    recovered: 0,
    ambiguous: 0,
    truncated: false,
  };
}

function toResult(
  totals: SweepTotals,
  params: { summary: string; dryRun: boolean; exitCode: 0 | 1 }
): AttachmentRowReconcileResult {
  return {
    summary: params.summary,
    scanned: totals.scanned,
    newlyAbsent: totals.newlyAbsent,
    orphansConfirmed: totals.orphansConfirmed,
    orphansDeleted: totals.orphansDeleted,
    recovered: totals.recovered,
    ambiguous: totals.ambiguous,
    truncated: totals.truncated,
    dryRun: params.dryRun,
    exitCode: params.exitCode,
  };
}

export const attachmentRowReconcileService = {
  /**
   * Reconciles the `fileAttachment` table against the `FILE_ATTACHMENTS_BUCKET`,
   * deleting rows whose S3 object does not exist (ORPHANED_ROW). These arise
   * when `requestUpload` commits the row and the client then never completes the
   * presigned PUT — a crash, a closed tab, or an abandoned upload.
   *
   * This is the reciprocal of `attachmentReconcileService`, which sweeps the
   * object side (objects with no backing row).
   *
   * Five safety properties carry this sweep, because it destroys data:
   *
   * 1. The bucket is probed ONCE before anything is classified. A missing or
   *    unreachable bucket answers every HeadObject with a 404 that is
   *    indistinguishable from a missing key, which would classify the entire
   *    table as orphaned; the probe turns that into one run-level failure.
   * 2. Only an authoritative 404 for the key counts as absence. Any other S3
   *    failure is counted `ambiguous` and the row is kept.
   * 3. Absence must be observed TWICE, by two different runs at least
   *    `MIN_ABSENCE_CONFIRMATION_GAP_SECONDS` apart, and the second observation
   *    re-checks S3 immediately before the delete. An upload still transferring
   *    when the first observation ran has landed by the second, which clears the
   *    mark instead of deleting the row.
   * 4. Only rows older than `ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS` are
   *    candidates, applied at SELECT time — so a row created during the sweep can
   *    never be in a delete set built from it — and every predicate is repeated
   *    in the `deleteMany` itself.
   * 5. It is dry-run unless `apply` is passed, and both rows scanned and rows
   *    deleted are capped per run, with `truncated` stating when a cap was hit
   *    rather than letting a partial survey read as a complete one.
   *
   * Dry run gates DELETION only. The absence ledger (`reconciledAt`,
   * `reconcileAbsent`) is maintained in both modes: it is what advances the scan
   * across nights and what makes the reported blast radius a confirmed number
   * rather than a first guess. A mark can never delete a row on its own.
   *
   * A non-zero `ambiguous` count does NOT fail the run: transient S3 errors are
   * expected and those rows are simply reconsidered later. `exitCode` is 1 only
   * when the sweep itself fails, so the cron route can alert and 500.
   */
  async runRowReconcileSweep(
    options: AttachmentRowReconcileOptions = {}
  ): Promise<AttachmentRowReconcileResult> {
    const bucket = awsKeys().FILE_ATTACHMENTS_BUCKET;
    const dryRun = options.apply !== true;
    const totals = emptyTotals();

    if (!bucket) {
      // No bucket configured (e.g. local/dev) → nothing to reconcile. Mirrors
      // the object-side sweep and the upload path, which only error when an
      // upload is actually attempted.
      return toResult(totals, {
        summary:
          "FILE_ATTACHMENTS_BUCKET not configured; row reconcile skipped",
        dryRun,
        exitCode: 0,
      });
    }

    const now = options.now ?? new Date();
    const context: PhaseContext = {
      bucket,
      cutoff: new Date(
        now.getTime() - ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS * 1000
      ),
      confirmBefore: new Date(
        now.getTime() - MIN_ABSENCE_CONFIRMATION_GAP_SECONDS * 1000
      ),
      now,
      dryRun,
      maxDeletions: clampPositive(options.maxDeletions, MAX_DELETIONS_PER_RUN),
      maxRowsScanned: clampPositive(
        options.maxRowsScanned,
        MAX_ROWS_SCANNED_PER_RUN
      ),
    };

    try {
      await headAttachmentsBucket(bucket);
    } catch (err) {
      // Systemic, not per-row: fail the whole run without classifying anything.
      const message = getSafeAttachmentStorageErrorMessage(err);
      log.error("[reconcile-attachment-rows] bucket probe failed", {
        error: message,
      });
      return toResult(totals, {
        summary: `Attachment row reconcile aborted: the attachments bucket is not accessible, so no row can be classified: ${message}`,
        dryRun,
        exitCode: 1,
      });
    }

    try {
      await runConfirmPhase(context, totals);
      await runDiscoveryPhase(context, totals);

      if (totals.ambiguous > 0) {
        // Surfaced here, where the S3 error that caused it is still in hand.
        log.warn(
          "[reconcile-attachment-rows] rows skipped with indeterminate S3 state",
          {
            ambiguous: totals.ambiguous,
            error: totals.firstAmbiguousError,
            scanned: totals.scanned,
          }
        );
      }

      return toResult(totals, {
        summary: buildSummary(totals, dryRun),
        dryRun,
        exitCode: 0,
      });
    } catch (err) {
      const message = getSafeAttachmentStorageErrorMessage(err);
      log.error("[reconcile-attachment-rows] row reconcile sweep failed", {
        error: message,
        scanned: totals.scanned,
        newlyAbsent: totals.newlyAbsent,
        orphansConfirmed: totals.orphansConfirmed,
        orphansDeleted: totals.orphansDeleted,
        ambiguous: totals.ambiguous,
        cutoff: context.cutoff.toISOString(),
      });
      return toResult(totals, {
        summary: `Attachment row reconcile sweep failed after scanning ${totals.scanned} row(s), deleting ${totals.orphansDeleted}: ${message}`,
        dryRun,
        exitCode: 1,
      });
    }
  },
};
