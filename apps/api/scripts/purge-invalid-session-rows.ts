/**
 * FEA-1964 (PRD-474, Feature 1): Back up and purge invalid server
 * `session_detail` rows.
 *
 * The server only ever upserts session rows by `(computeTargetId,
 * externalSessionId)` and never deletes, so it retains stale rows written by
 * earlier desktop parser bugs (pre-`DATA_REVISION` and revisions 1→2→3). Those
 * rows inflate web-side counts and pollute analytics. This operation removes
 * them, org-scoped and reversible-by-resync:
 *
 *   1. Count-first (mandatory dry-run) using the invalid-row predicate.
 *   2. Export the matched parent + child + artifact rows to a timestamped,
 *      org-keyed JSON backup before any DELETE.
 *   3. Delete inside a single transaction by removing the parent `artifact`
 *      rows; ON DELETE CASCADE removes `session_detail` and its
 *      `agent_session_token_usage` / `agent_session_events` children.
 *   4. Assert no orphaned child rows remain (else the transaction rolls back).
 *
 * Backup scope: the JSON backup captures the `session_detail` row, its
 * `agent_session_token_usage` / `agent_session_events` children, and the parent
 * `artifact` row. Deleting the artifact ALSO cascades to derived association
 * rows the backup does NOT capture — `artifact_links`,
 * `session_pull_request_links`, `tag_artifacts`, `favorite_artifacts`,
 * `comment_threads`, `artifact_evaluations`, `artifact_ratings`,
 * `file_attachments`, `linear_subtasks` — and NULLs the `loops` /
 * `loop_session_artifact` pointers (`onDelete: SetNull`). The session payload
 * itself is reconstructed by client resync, but those human/server-side
 * associations are NOT — once deleted they are gone unless restored by hand.
 * For stale invalid sessions they are almost always absent, so the dry run
 * COUNTS them (see {@link countCascadeAssociations}) and `main()` prints a
 * warning when any exist: review/accept that loss before executing. The backup
 * is the session payload for an audit/spot-restore, NOT a complete snapshot of
 * everything the cascade removes — do not treat it alone as a full restore source.
 *
 * Repopulation is NOT this script's job: every desktop client re-uploads its
 * corrected local history on the next cold start (the existing
 * full-backfill-on-restart behavior). The persisted-cursor work (FEA-1962) and
 * the server-invalidatable epoch are deliberately out of scope here; this purge
 * must complete and repopulate before that lands (PRD-474, Option B).
 *
 * Usage:
 *   cd apps/api
 *   # Dry run (default — counts only, writes nothing):
 *   ORG_ID=<uuid> DATABASE_URL=<url> npx tsx scripts/purge-invalid-session-rows.ts
 *   # Execute (org-scoped; writes a backup file first):
 *   DRY_RUN=0 ORG_ID=<uuid> DATABASE_URL=<url> npx tsx scripts/purge-invalid-session-rows.ts
 *   # Very large org: raise the delete-transaction timeout (default 120000ms):
 *   DRY_RUN=0 ORG_ID=<uuid> PURGE_TX_TIMEOUT_MS=600000 DATABASE_URL=<url> npx tsx ...
 */
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Prisma, withDb } from "@repo/database";

/** Characters in an ISO timestamp that are unsafe in a filename. */
const BACKUP_TIMESTAMP_UNSAFE_CHARS = /[:.]/g;

/**
 * Default interactive-transaction timeout for the delete. The cascade
 * `deleteMany` plus the in-transaction re-fetch and orphan check run inside one
 * Prisma transaction, whose built-in default is only 5s — a large invalid set
 * can exceed that and roll back with P2028. The dry run sizes the set first, so
 * this is a generous ceiling, not a license to delete unbounded data in one
 * shot. Override per-run via `PURGE_TX_TIMEOUT_MS` for very large orgs (a
 * multi-hundred-thousand-row cascade can need more than 120s).
 */
const DEFAULT_PURGE_TX_TIMEOUT_MS = 120_000;
/** Default max time to wait for a connection before the tx starts. */
const DEFAULT_PURGE_TX_MAX_WAIT_MS = 10_000;

/**
 * Parse a positive-integer env var, falling back to `fallback` when it is unset,
 * empty, or not a positive integer (so a typo can never silently disable the
 * timeout floor).
 */
export function positiveIntEnv(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Owner-only mode for the backup file — it contains customer session rows. */
const BACKUP_FILE_MODE = 0o600;

/**
 * Max ids per `{ in: [...] }` clause. PostgreSQL's wire protocol caps bind
 * parameters at 32767 (int16), and Prisma surfaces overflow as P2029. The
 * count/report queries avoid id lists entirely (they filter by the invalid-row
 * predicate, which is parameter-count-independent), but the execute delete and
 * its orphan check must target the exact backed-up id set, so they batch it. A
 * 10k ceiling leaves ample headroom under the 32767 limit.
 */
const ID_PARAM_CHUNK_SIZE = 10_000;

/** Split a list into chunks of at most `size` (size must be > 0). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Minimum `data_revision` considered valid on the server. Rows below this (or
 * with a NULL revision, i.e. pre-revision-tracking) are stale: the corrected
 * desktop parser re-emits them at the current revision on resync.
 *
 * This is a cloud-cleanup lower bound, not the desktop app's current
 * `DATA_REVISION`. Bump it only when server-side purge criteria intentionally
 * expand; ordinary desktop revision bumps should not change it automatically.
 */
export const CURRENT_SERVER_MIN_REVISION = 3;

type DbClient = Parameters<Parameters<typeof withDb>[0]>[0];
type TxClient = Parameters<Parameters<typeof withDb.tx>[0]>[0];
type AnyDb = DbClient | TxClient;

export class PredicateDriftError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      "Predicate drift: the invalid-row set changed between backup and delete " +
        `(backed up ${expected} session(s), transaction matched ${actual}; the ` +
        "count may match while the row identities differ). Refusing to delete. " +
        "Re-run the dry run."
    );
    this.name = "PredicateDriftError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class BackupRequiredError extends Error {
  constructor() {
    super(
      "Refusing to delete without a backup writer: execute mode requires a " +
        "`writeBackup` dependency so deleted rows are exported first."
    );
    this.name = "BackupRequiredError";
  }
}

/** True when two ID lists contain exactly the same elements (order-independent). */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

export class OrphanRowsRemainError extends Error {
  readonly tokenUsageCount: number;
  readonly eventCount: number;

  constructor(tokenUsageCount: number, eventCount: number) {
    super(
      `Orphaned child rows survived the purge (token_usage=${tokenUsageCount}, ` +
        `events=${eventCount}). Rolling back. Cascade did not behave as expected.`
    );
    this.name = "OrphanRowsRemainError";
    this.tokenUsageCount = tokenUsageCount;
    this.eventCount = eventCount;
  }
}

/**
 * The invalid-row predicate (org-scoped), expressed once as a Prisma
 * `where` so the count, export, and delete steps cannot drift apart.
 */
export function invalidSessionWhere(
  orgId: string
): Prisma.SessionDetailWhereInput {
  return {
    artifact: { organizationId: orgId },
    OR: [
      { dataRevision: null },
      { dataRevision: { lt: CURRENT_SERVER_MIN_REVISION } },
    ],
  };
}

export type InvalidSessionRow = {
  artifactId: string;
  externalSessionId: string;
  computeTargetId: string;
  dataRevision: number | null;
};

/** Matched parent rows (no children) — used for the count-first step. */
export function findInvalidSessionRows(
  db: AnyDb,
  orgId: string
): Promise<InvalidSessionRow[]> {
  return db.sessionDetail.findMany({
    where: invalidSessionWhere(orgId),
    select: {
      artifactId: true,
      externalSessionId: true,
      computeTargetId: true,
      dataRevision: true,
    },
  });
}

/**
 * Count the dependent child rows the cascade will remove (reporting). Filters
 * via the `session` relation using the invalid-row predicate, not an id list, so
 * it is parameter-count-independent and scales to any org size.
 */
export async function countDependents(
  db: AnyDb,
  orgId: string
): Promise<{ tokenUsageCount: number; eventCount: number }> {
  const sessionWhere = invalidSessionWhere(orgId);
  const [tokenUsageCount, eventCount] = await Promise.all([
    db.agentSessionTokenUsage.count({ where: { session: sessionWhere } }),
    db.agentSessionEvent.count({ where: { session: sessionWhere } }),
  ]);
  return { tokenUsageCount, eventCount };
}

/**
 * Post-delete orphan tripwire: count child rows still referencing the deleted
 * session ids. This MUST query by id (the deleted sessions no longer match any
 * relation predicate), so it batches the id list under the bind-parameter limit.
 */
export async function countOrphanedChildren(
  db: AnyDb,
  artifactIds: string[]
): Promise<{ tokenUsageCount: number; eventCount: number }> {
  let tokenUsageCount = 0;
  let eventCount = 0;
  for (const ids of chunk(artifactIds, ID_PARAM_CHUNK_SIZE)) {
    const [tokenUsage, events] = await Promise.all([
      db.agentSessionTokenUsage.count({
        where: { agentSessionId: { in: ids } },
      }),
      db.agentSessionEvent.count({ where: { agentSessionId: { in: ids } } }),
    ]);
    tokenUsageCount += tokenUsage;
    eventCount += events;
  }
  return { tokenUsageCount, eventCount };
}

/**
 * Associations on the matched artifacts that the cascade ALSO removes — or, for
 * Loop pointers, nulls — but that the JSON backup does NOT capture and client
 * resync does NOT rebuild: human/server-side state (comments, favorites, tags,
 * ratings, evaluations, artifact links, attachments, Linear subtasks) and Loop
 * references (`Loop.artifactId` / `Loop.sessionArtifactId` are `onDelete:
 * SetNull`, so a referencing loop survives with a dangling pointer). For stale
 * invalid sessions these are almost always zero, but "almost always" is not a
 * gate — the dry run reports them so an operator can confirm none exist (or
 * consciously accept the loss) before executing.
 */
export type CascadeAssociationCounts = {
  artifactLinks: number;
  sessionPrLinks: number;
  ratings: number;
  evaluations: number;
  commentThreads: number;
  fileAttachments: number;
  tagArtifacts: number;
  favorites: number;
  linearSubtasks: number;
  /** Loops left with a dangling pointer (SetNull), not deleted. */
  loopReferences: number;
  /** Sum of every field above — the single go/no-go signal. */
  total: number;
};

const ZERO_ASSOCIATIONS: CascadeAssociationCounts = {
  artifactLinks: 0,
  sessionPrLinks: 0,
  ratings: 0,
  evaluations: 0,
  commentThreads: 0,
  fileAttachments: 0,
  tagArtifacts: 0,
  favorites: 0,
  linearSubtasks: 0,
  loopReferences: 0,
  total: 0,
};

/**
 * Count, for the matched artifacts, the wider cascade fallout the backup does
 * not capture (see {@link CascadeAssociationCounts}). Read-only; used in the
 * dry-run report as a pre-execute safety signal. Filters via the `session`
 * relation using the invalid-row predicate, not an id list, so it is
 * parameter-count-independent and scales to any org size.
 */
export async function countCascadeAssociations(
  db: AnyDb,
  orgId: string
): Promise<CascadeAssociationCounts> {
  const sessionWhere = invalidSessionWhere(orgId);
  const [withCounts, loopReferences] = await Promise.all([
    db.artifact.findMany({
      where: { session: sessionWhere },
      select: {
        _count: {
          select: {
            sourceLinks: true,
            targetLinks: true,
            sessionPrLinks: true,
            ratings: true,
            evaluations: true,
            commentThreads: true,
            fileAttachments: true,
            tagArtifacts: true,
            favoritedBy: true,
            linearSubtasks: true,
          },
        },
      },
    }),
    db.loop.count({
      where: {
        OR: [
          { artifact: { session: sessionWhere } },
          { sessionArtifact: { session: sessionWhere } },
        ],
      },
    }),
  ]);

  const counts = withCounts.reduce<CascadeAssociationCounts>(
    (acc, { _count: c }) => {
      acc.artifactLinks += c.sourceLinks + c.targetLinks;
      acc.sessionPrLinks += c.sessionPrLinks;
      acc.ratings += c.ratings;
      acc.evaluations += c.evaluations;
      acc.commentThreads += c.commentThreads;
      acc.fileAttachments += c.fileAttachments;
      acc.tagArtifacts += c.tagArtifacts;
      acc.favorites += c.favoritedBy;
      acc.linearSubtasks += c.linearSubtasks;
      return acc;
    },
    { ...ZERO_ASSOCIATIONS }
  );
  counts.loopReferences = loopReferences;
  counts.total =
    counts.artifactLinks +
    counts.sessionPrLinks +
    counts.ratings +
    counts.evaluations +
    counts.commentThreads +
    counts.fileAttachments +
    counts.tagArtifacts +
    counts.favorites +
    counts.linearSubtasks +
    counts.loopReferences;
  return counts;
}

/** Full matched rows incl. children + parent artifact — the backup payload. */
export function exportInvalidSessionRows(db: AnyDb, orgId: string) {
  return db.sessionDetail.findMany({
    where: invalidSessionWhere(orgId),
    include: { tokenUsageByModel: true, events: true, artifact: true },
  });
}

export type PurgeBackup = {
  orgId: string;
  minRevision: number;
  exportedAt: string;
  sessionDetails: Awaited<ReturnType<typeof exportInvalidSessionRows>>;
};

export type PurgeReport = {
  orgId: string;
  dryRun: boolean;
  minRevision: number;
  /** Matched `session_detail` rows (== parent artifacts == exported on execute). */
  targetCount: number;
  tokenUsageCount: number;
  eventCount: number;
  exportedCount: number;
  /** Parent artifacts deleted; children removed by cascade. */
  deletedCount: number;
  backupPath: string | null;
  /** Wider cascade fallout the backup doesn't capture — a pre-execute signal. */
  associations: CascadeAssociationCounts;
};

export type PurgeDeps = {
  /** Persist the backup; returns where it was written. Injected for testability. */
  writeBackup?: (backup: PurgeBackup) => Promise<string>;
  /** Clock seam for deterministic export timestamps in tests. */
  now?: () => Date;
  /** Delete-transaction timeout (ms). Defaults to DEFAULT_PURGE_TX_TIMEOUT_MS. */
  txTimeoutMs?: number;
  /** Delete-transaction max connection wait (ms). Defaults to DEFAULT_PURGE_TX_MAX_WAIT_MS. */
  txMaxWaitMs?: number;
};

/**
 * Back up and purge invalid `session_detail` rows for one org.
 *
 * Dry run: counts only, writes nothing.
 *
 * Execute: export the matched rows (read-only) and persist the backup BEFORE
 * opening the delete transaction — keeping the file I/O and the full child read
 * out of the interactive transaction avoids Prisma's transaction timeout on
 * large orgs. A `writeBackup` dependency is then MANDATORY: there is no silent
 * delete-without-backup path. The transaction re-fetches the invalid set and
 * deletes only when its identity (not merely its size) still matches the
 * backed-up set, so a same-size rotation (one row repopulated, another newly
 * invalid) cannot delete a different set than was backed up. The delete is
 * additionally org-scoped as defense-in-depth, then a post-delete orphan check
 * rolls the transaction back if any child row survives.
 *
 * Memory note: the export is unpaginated, which is acceptable here — the
 * matched set is only the *invalid* subset (stale/below-revision rows), the
 * tool runs per-org under an operator, and the dry run reports the size first
 * so an unexpectedly large set is caught before execution.
 */
export async function purgeInvalidSessionRows(
  { orgId, dryRun }: { orgId: string; dryRun: boolean },
  deps: PurgeDeps = {}
): Promise<PurgeReport> {
  const now = deps.now ?? (() => new Date());
  const txTimeoutMs = deps.txTimeoutMs ?? DEFAULT_PURGE_TX_TIMEOUT_MS;
  const txMaxWaitMs = deps.txMaxWaitMs ?? DEFAULT_PURGE_TX_MAX_WAIT_MS;

  if (dryRun) {
    // All three queries filter by the invalid-row predicate (no id lists), so
    // the dry run is parameter-count-independent regardless of org size.
    const [targetCount, { tokenUsageCount, eventCount }, associations] =
      await Promise.all([
        withDb((db) =>
          db.sessionDetail.count({ where: invalidSessionWhere(orgId) })
        ),
        withDb((db) => countDependents(db, orgId)),
        withDb((db) => countCascadeAssociations(db, orgId)),
      ]);
    return {
      orgId,
      dryRun: true,
      minRevision: CURRENT_SERVER_MIN_REVISION,
      targetCount,
      tokenUsageCount,
      eventCount,
      exportedCount: 0,
      deletedCount: 0,
      backupPath: null,
      associations,
    };
  }

  // EXECUTE. Export (read-only) outside any transaction — this is both the
  // count-first target and the backup payload. Dependent counts come from the
  // exported children, so no extra query is needed.
  const exported = await withDb((db) => exportInvalidSessionRows(db, orgId));
  const exportedIds = exported.map((row) => row.artifactId);
  const tokenUsageCount = exported.reduce(
    (sum, row) => sum + row.tokenUsageByModel.length,
    0
  );
  const eventCount = exported.reduce((sum, row) => sum + row.events.length, 0);
  const associations = await withDb((db) =>
    countCascadeAssociations(db, orgId)
  );

  const base: PurgeReport = {
    orgId,
    dryRun: false,
    minRevision: CURRENT_SERVER_MIN_REVISION,
    targetCount: exported.length,
    tokenUsageCount,
    eventCount,
    exportedCount: 0,
    deletedCount: 0,
    backupPath: null,
    associations,
  };

  if (exported.length === 0) {
    return base;
  }

  // Backup is mandatory before any delete — no silent delete-without-backup.
  if (!deps.writeBackup) {
    throw new BackupRequiredError();
  }
  const backupPath = await deps.writeBackup({
    orgId,
    minRevision: CURRENT_SERVER_MIN_REVISION,
    exportedAt: now().toISOString(),
    sessionDetails: exported,
  });

  const deletedCount = await withDb.tx(
    async (tx) => {
      // Predicate-drift guard: delete only if the still-invalid set is identical
      // (by row identity, not just count) to what we backed up. A row that became
      // valid, disappeared, or was swapped for a different invalid row aborts.
      // (The tx timeout is raised — the cascade delete below runs inside this tx.)
      const current = await findInvalidSessionRows(tx, orgId);
      const currentIds = current.map((row) => row.artifactId);
      if (!sameIdSet(currentIds, exportedIds)) {
        throw new PredicateDriftError(exportedIds.length, currentIds.length);
      }

      // Delete the parent artifacts; ON DELETE CASCADE removes session_detail and
      // its agent_session_token_usage / agent_session_events children — and also
      // the artifact's other dependents (links, tags, favorites, comment threads,
      // evaluations/ratings, PR links, attachments, linear subtasks) which the
      // backup does not capture and resync does NOT rebuild — the dry run counts
      // them first (see "Backup scope" in the file header). The organizationId
      // guard is redundant with the org-scoped predicate above but is cheap
      // defense-in-depth on an irreversible delete.
      // Batched so the `id IN (...)` clause stays under the bind-parameter
      // limit; each batch is org-scoped as defense-in-depth.
      let deleted = 0;
      for (const ids of chunk(exportedIds, ID_PARAM_CHUNK_SIZE)) {
        const batch = await tx.artifact.deleteMany({
          where: { id: { in: ids }, organizationId: orgId },
        });
        deleted += batch.count;
      }

      // Orphan check: nothing should still reference the deleted sessions.
      const orphans = await countOrphanedChildren(tx, exportedIds);
      if (orphans.tokenUsageCount > 0 || orphans.eventCount > 0) {
        throw new OrphanRowsRemainError(
          orphans.tokenUsageCount,
          orphans.eventCount
        );
      }
      return deleted;
    },
    { timeout: txTimeoutMs, maxWait: txMaxWaitMs }
  );

  return {
    ...base,
    exportedCount: exported.length,
    deletedCount,
    backupPath,
  };
}

export type RunConfig =
  | { ok: true; orgId: string; dryRun: boolean }
  | { ok: false; error: string };

/** Parse + validate operator env. Org-scoped always; dry run is the default. */
export function resolveRunConfig(env: NodeJS.ProcessEnv): RunConfig {
  const dryRun = env.DRY_RUN !== "0";
  const orgId = env.ORG_ID?.trim();
  if (!orgId) {
    return {
      ok: false,
      error:
        "ORG_ID is required (this purge is strictly org-scoped). " +
        "Set ORG_ID=<uuid>; the run defaults to a dry run unless DRY_RUN=0.",
    };
  }
  return { ok: true, orgId, dryRun };
}

function backupReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function writeBackupToFile(backup: PurgeBackup): Promise<string> {
  const stamp = backup.exportedAt.replaceAll(
    BACKUP_TIMESTAMP_UNSAFE_CHARS,
    "-"
  );
  // Write outside the repo working tree by default so the backup — which
  // contains customer session rows — cannot be accidentally committed. The
  // operator can override the directory via PURGE_BACKUP_DIR.
  const dir = process.env.PURGE_BACKUP_DIR?.trim() || tmpdir();
  const path = join(
    dir,
    `purge-invalid-session-rows-${backup.orgId}-${stamp}.ndjson`
  );
  // Newline-delimited JSON: a header line, then one session per line.
  // Serializing the whole payload as a single string throws
  // `RangeError: Invalid string length` on large orgs (V8 caps strings at
  // ~512MB; ~900K event rows overflow it). Per-line serialization stays far
  // under that limit and keeps memory flat. Created 0o600 (customer PII).
  const { sessionDetails, ...header } = backup;
  const handle = await open(path, "w", BACKUP_FILE_MODE);
  try {
    await handle.write(
      `${JSON.stringify({ ...header, sessionCount: sessionDetails.length }, backupReplacer)}\n`
    );
    for (const session of sessionDetails) {
      await handle.write(`${JSON.stringify(session, backupReplacer)}\n`);
    }
  } finally {
    await handle.close();
  }
  return path;
}

export async function main() {
  const config = resolveRunConfig(process.env);
  if (!config.ok) {
    console.error(`ERROR: ${config.error}`);
    process.exit(1);
  }

  const { orgId, dryRun } = config;
  const txTimeoutMs = positiveIntEnv(
    process.env.PURGE_TX_TIMEOUT_MS,
    DEFAULT_PURGE_TX_TIMEOUT_MS
  );
  const txMaxWaitMs = positiveIntEnv(
    process.env.PURGE_TX_MAX_WAIT_MS,
    DEFAULT_PURGE_TX_MAX_WAIT_MS
  );
  console.log(
    `Invalid session_detail purge — mode: ${dryRun ? "DRY RUN" : "EXECUTE"}, ` +
      `org: ${orgId}, min_revision: ${CURRENT_SERVER_MIN_REVISION}` +
      (dryRun ? "" : `, tx_timeout_ms: ${txTimeoutMs}`)
  );

  const report = await purgeInvalidSessionRows(
    { orgId, dryRun },
    { writeBackup: writeBackupToFile, txTimeoutMs, txMaxWaitMs }
  );

  console.log(
    `  Matched ${report.targetCount} invalid session(s); dependents: ` +
      `${report.tokenUsageCount} token-usage, ${report.eventCount} event row(s).`
  );

  const a = report.associations;
  if (a.total > 0) {
    // Visible warning, not suppressed: these are removed/nulled by the cascade,
    // are NOT in the backup, and are NOT rebuilt by client resync.
    console.warn(
      `  ⚠ ${a.total} backup-uncaptured association(s) on the matched ` +
        "artifacts (NOT reversible by resync — review before executing):\n" +
        `      artifact_links=${a.artifactLinks}, session_pr_links=${a.sessionPrLinks}, ` +
        `comment_threads=${a.commentThreads}, ratings=${a.ratings}, ` +
        `evaluations=${a.evaluations}, tags=${a.tagArtifacts}, ` +
        `favorites=${a.favorites}, attachments=${a.fileAttachments}, ` +
        `linear_subtasks=${a.linearSubtasks}, ` +
        `loop_references=${a.loopReferences} (loops left with a dangling pointer)`
    );
  } else {
    console.log(
      "  No backup-uncaptured associations (links/comments/tags/favorites/" +
        "ratings/evaluations/attachments/loop refs) on the matched artifacts."
    );
  }

  if (dryRun) {
    console.log("\nDry run complete. Set DRY_RUN=0 to execute.");
    return;
  }

  if (report.targetCount === 0) {
    console.log("\nNothing to purge.");
    return;
  }

  console.log(
    `  Backup written: ${report.backupPath}\n` +
      `  Deleted ${report.deletedCount} parent artifact(s)/session(s); ` +
      "children removed by cascade; orphan check passed."
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Invalid session purge failed:", err);
    process.exit(1);
  });
}
