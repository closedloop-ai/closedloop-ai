/**
 * @file billing-mode-heal.ts
 * @description ISS-4869 — convergent boot heal for sessions frozen at an
 * `unknown` billing mode.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The Keychain detector lets `resolveBillingMode` answer correctly for rows that
 * were persisted as `unknown` before macOS Keychain credentials were understood.
 * Every LOCAL read already benefits, because the Sessions and Branches paths
 * re-resolve at read time. The CLOUD copy does not: the metadata sync lane
 * selects by `sessions.updated_at` (`listUpdatedSessionCursorRows`), and a
 * historical, completed session never changes again — so once the durable cursor
 * has advanced past it, that row is never re-selected and its cloud copy keeps
 * the stale `unknown` forever, dropping subscription-covered spend into the
 * cloud's unclassified ledger.
 *
 * This pass re-stamps those rows and bumps their `updated_at` in the same
 * statement, which is precisely how the sync lane is asked to re-upload them.
 * The sibling boot heals (`recomputeImportedAgentTurnAnalytics`,
 * `healCacheCostSplit`) ask for the same re-upload, but they reach it by
 * wrapping their own write and a `bumpSessionsUpdatedAt` call in a
 * `$transaction`; this pass folds both columns into ONE `UPDATE`, so the
 * atomicity is structural rather than transactional.
 *
 * ── Why it is idempotent, without a marker table ──────────────────────────────
 * It is CONVERGENT, so no `*_backfill_seen` high-water mark is needed: the pass
 * selects only rows whose stored mode is NULL/`unknown`, and it writes only a
 * DEFINITE mode. A healed row therefore no longer matches the selection
 * predicate and is never bumped again — the second boot selects nothing and
 * writes nothing.
 *
 * A row whose harness still resolves to `unknown` (nothing detectable on this
 * machine yet) is deliberately left ALONE rather than re-stamped. That keeps it
 * eligible to heal later — after the user logs into Claude Code — and, just as
 * importantly, stops the pass from bumping `updated_at` on every boot for rows
 * it cannot actually classify, which would churn the sync cursor forever.
 *
 * Detection is resolved ONCE PER DISTINCT HARNESS rather than per row: the
 * answer is a machine-level question, so a corpus of N sessions costs one
 * resolution per harness (a handful), not N.
 *
 * ── ISS-5259: the pass-start boundary, and why it is on `updated_at` ──────────
 * Boot maintenance runs CONCURRENTLY with live writers — DB-host readiness lets
 * `minimalCodexSessionUpsert` interleave a brand-new codex row (stamped
 * `billing_mode = 'unknown'`, `updated_at` = the writer's wall clock) with this
 * pass. Convergence alone does not protect that row: the drain re-evaluates the
 * predicate on every chunk, so a later chunk would pick the newcomer up and
 * overwrite its NEWER `updated_at` with this pass's OLDER stamp. If the sync
 * cursor had already advanced past the newer value, the healed row would then
 * sit BEHIND the durable cursor and never sync — silent data loss.
 *
 * So the target set is bounded at pass start by `updated_at`, not by `id`:
 * `sessions.id` is a `String @id` with no default, populated from the HARNESS's
 * own session identifier (a Claude/Codex transcript UUID, a `copilot-cli-…` /
 * `copilot-chat-…` composite, …). Those are neither globally ordered nor
 * insert-ordered, so an id high-water mark is not a time boundary at all.
 * `updated_at` is: the durable sync cursor itself selects and orders on it
 * (`listUpdatedSessionCursorRows` compares it as a RAW STRING), so restricting
 * the pass to rows whose `updated_at` sorts strictly before the pass-start stamp
 * makes every write this pass performs monotone in exactly the ordering the
 * cursor uses — the new value is `>= passStart >` the old one, for every row it
 * can touch. A NULL `updated_at` is included: it is invisible to the cursor
 * today, so stamping it can only move it forward.
 */
import type { BillingMode } from "../../shared/billing-mode.js";
import { detectBillingMode } from "../cost/billing-mode-detector.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { chunkWatermark } from "./session-sync-watermark.js";

/** Stored values that mean "this row was never classified". */
const UNRESOLVED_BILLING_MODE_SQL =
  "(billing_mode IS NULL OR billing_mode = 'unknown')";

/**
 * ISS-5259 high-water boundary. Restricts the pass to rows that were already
 * quiescent when it started, so a row written DURING the pass is never
 * re-stamped with the pass's older watermark. See the module header for why the
 * bound is on `updated_at` rather than on `id`.
 *
 * Both queries need it under a different positional parameter, so the index is
 * a parameter of the fragment rather than baked in.
 */
function beforePassStartSql(passStartParam: string): string {
  return `(updated_at IS NULL OR updated_at < ${passStartParam})`;
}

/**
 * Sessions re-stamped per statement — and therefore the width of the tied-top
 * `updated_at` group this pass leaves behind for the sync cursor.
 *
 * Deliberately NOT `SESSION_ANALYTICS_BACKFILL_CHUNK`. That constant is also 25,
 * but it is sized against a `json_each` scan over every message of every session
 * in the batch, which blew the db-host worker's heap at 500 (FEA-3056). This
 * pass hydrates nothing and writes two scalar columns, so that ceiling cannot
 * bind here and importing it would document a failure mode this code can't hit.
 *
 * The constraint that DOES bind is the sync cursor: it carries every id sharing
 * the top `updated_at` and expands them into positional `id NOT IN ($2, $3, …)`
 * placeholders on each incremental tick until the watermark advances (see
 * `healHarness`). So the value trades statement count against per-tick cursor
 * width — not memory. 25 keeps that group narrow and sits far under the
 * `MAX_OBSERVED_TOP_IDS` (5000) threshold past which the persisted set is
 * dropped and a restart re-enumerates the whole group.
 */
const BILLING_MODE_HEAL_CHUNK = 25;

/**
 * ISS-5259 review: consecutive chunk-WRITE failures tolerated for one harness
 * before the pass gives up on it.
 *
 * A single failure is skipped rather than fatal (see `healHarness`), so a chunk
 * that fails for a reason tied to its own rows cannot head-of-line block the
 * healthy tail behind it on every boot. This cap is what stops that tolerance
 * from turning a lane-wide failure (the disk is full, the store is locked for
 * the whole boot) into a corpus-length walk of failing writes: three in a row
 * with nothing in between succeeding means the problem is not the rows.
 */
const MAX_CONSECUTIVE_FAILED_CHUNKS = 3;

/**
 * Re-stamp sessions stuck at an unknown billing mode and re-queue them for the
 * cloud metadata lane. Background/boot pass — never throws into the caller.
 */
export async function healUnknownBillingModes(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = BILLING_MODE_HEAL_CHUNK
): Promise<void> {
  // ISS-5259: captured BEFORE the first read, so the boundary covers every
  // statement this pass issues — a row written after this instant is outside the
  // target set for the whole pass, not just for the chunks that follow it.
  const passStart = new Date().toISOString();
  // The `harness IS NOT NULL` predicate is what makes the row type non-null.
  const harnesses = await prisma.client.$queryRawUnsafe<{ harness: string }[]>(
    `SELECT DISTINCT harness FROM sessions
     WHERE ${UNRESOLVED_BILLING_MODE_SQL}
       AND harness IS NOT NULL
       AND ${beforePassStartSql("$1")}`,
    passStart
  );
  if (harnesses.length === 0) {
    return;
  }
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healed = 0;
  for (const { harness } of harnesses) {
    // Only a DEFINITE answer is persisted; "unknown" leaves the row eligible.
    const mode = detectBillingMode(harness);
    if (mode === "unknown") {
      continue;
    }
    healed += await healHarness(prisma, log, {
      chunkSize: safeChunkSize,
      harness,
      mode,
      passStart,
    });
  }
  if (healed > 0) {
    log(
      `billing-mode heal complete (ISS-4869): re-stamped ${healed} session(s)`
    );
  }
}

/**
 * ISS-5259: the keyset-bounded chunk SELECT, as a builder rather than a literal.
 *
 * The keyset term is EMITTED CONDITIONALLY — omitted entirely on the first
 * chunk, a bare `AND id > $2` from the second onward. It cannot be written as
 * one statement with a nullable bound: SQLite plans at PREPARE time, before any
 * parameter binds, so a `($n IS NULL OR id > $n)` form references no column the
 * planner can range over and degrades to a residual filter — `EXPLAIN QUERY
 * PLAN` reports the same `SCAN sessions USING INDEX sqlite_autoindex_sessions_1`
 * it reports with no keyset at all, which is exactly the full-index restart this
 * keyset exists to remove. The bare term plans as
 * `SEARCH … (id>?)`. `billing-mode-heal-scan.test.ts` pins that with a real
 * `EXPLAIN QUERY PLAN` against this builder's own output, because the semantic
 * keyset test below it is green under BOTH forms and cannot tell them apart.
 *
 * Conditional SQL construction is the local idiom for exactly this (see
 * `beforePassStartSql` above and `listUpdatedSessionCursorRows`'s `NOT IN`
 * expansion in `sync-source.ts`).
 *
 * Positional parameters, in textual order:
 * - without a bound: `$1` harness, `$2` pass start, `$3` chunk size
 * - with a bound:    `$1` harness, `$2` bound, `$3` pass start, `$4` chunk size
 */
export function billingModeHealChunkSelectSql(hasKeysetBound: boolean): string {
  const keysetSql = hasKeysetBound ? "\n       AND id > $2" : "";
  const passStartParam = hasKeysetBound ? "$3" : "$2";
  const limitParam = hasKeysetBound ? "$4" : "$3";
  return `SELECT id FROM sessions
     WHERE ${UNRESOLVED_BILLING_MODE_SQL}
       AND harness = $1${keysetSql}
       AND ${beforePassStartSql(passStartParam)}
     ORDER BY id ASC
     LIMIT ${limitParam}`;
}

/** Read one chunk's worth of candidate ids, ascending, past `bound`. */
function selectHealChunkIds(
  prisma: DesktopPrisma,
  input: { chunkSize: number; harness: string; passStart: string },
  bound: string | null
): Promise<{ id: string }[]> {
  const sql = billingModeHealChunkSelectSql(bound !== null);
  if (bound === null) {
    return prisma.client.$queryRawUnsafe<{ id: string }[]>(
      sql,
      input.harness,
      input.passStart,
      input.chunkSize
    );
  }
  return prisma.client.$queryRawUnsafe<{ id: string }[]>(
    sql,
    input.harness,
    bound,
    input.passStart,
    input.chunkSize
  );
}

/**
 * Re-stamp one chunk's ids and re-queue them for sync, in ONE statement.
 *
 * The selection predicate is RE-ASSERTED here rather than trusted from the
 * read: the ids were chosen by an earlier statement, and between the two a live
 * writer can have settled a row's mode or bumped it past the pass-start
 * boundary. Re-checking makes the write a no-op for exactly those rows, so the
 * ISS-5259 boundary guarantee holds against the write, not merely against the
 * read that fed it, and `RETURNING` reports what actually changed.
 */
function writeHealChunk(
  prisma: DesktopPrisma,
  input: {
    chunkNow: string;
    ids: string[];
    mode: Exclude<BillingMode, "unknown">;
    passStart: string;
  }
): Promise<{ id: string }[]> {
  const idPlaceholders = input.ids.map((_, i) => `$${i + 3}`).join(", ");
  const passStartParam = `$${input.ids.length + 3}`;
  return prisma.write((client) =>
    // One statement carries the re-stamp AND the sync re-queue, so they are
    // atomic by construction — a crash can never leave a healed row invisible
    // to the cursor, with no transaction to wrap them.
    client.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE sessions SET billing_mode = $1, updated_at = $2
       WHERE id IN (${idPlaceholders})
         AND ${UNRESOLVED_BILLING_MODE_SQL}
         AND ${beforePassStartSql(passStartParam)}
       RETURNING id`,
      input.mode,
      input.chunkNow,
      ...input.ids,
      input.passStart
    )
  );
}

function healFailureMessage(harness: string, error: unknown): string {
  return `billing-mode heal failed for ${harness}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Re-stamp one harness's unresolved rows in bounded, keyset-drained chunks.
 *
 * The rows never enter this process as ROWS — only their ids do, O(chunkSize)
 * at a time, and the re-stamp plus the sync re-queue stay one statement (the
 * `$queryRawUnsafe`-inside-`prisma.write` shape `timestamp-format-maintenance.ts`
 * uses). Memory is O(chunkSize), not O(stale corpus).
 *
 * ISS-5259: each chunk's ids feed a KEYSET (`id > lastBound`) that the next
 * chunk carries forward. An earlier revision of this pass drained statelessly —
 * re-running the identical statement worked because a healed row stops matching
 * the predicate — but with no index on `(harness, billing_mode)` each
 * `ORDER BY id ASC LIMIT n` restarted at the head of the primary-key index and
 * re-skipped every row the previous chunks had just healed, making a corpus-wide
 * heal roughly `n + 2n + … + N` row visits on the single writer. The keyset
 * costs one carried string and turns each chunk's read into an index RANGE
 * (`SEARCH … (id>?)`) that starts where the last one stopped. It is NOT a
 * substitute for the pass-start boundary: the ids are harness-supplied and
 * unordered in time, so `id > lastBound` bounds the SCAN, never the CLOCK (see
 * the module header).
 *
 * The bound comes from the READ, not from the write's `RETURNING`, and advances
 * whether or not the write landed. That is what keeps a failed chunk from
 * head-of-line blocking the healthy rows behind it: `lastBound` resets to NULL
 * every boot, so a chunk that fails for a reason tied to its own rows would,
 * under a bail-on-failure drain, be re-selected first on the next boot, fail
 * identically, and strand the whole tail forever. Skipping it costs only that
 * chunk (the pass is convergent — its rows still match next boot), which is the
 * same failure isolation the pre-keyset revision got from slicing a frozen id
 * array. `MAX_CONSECUTIVE_FAILED_CHUNKS` keeps that from walking the corpus
 * when the failure is lane-wide rather than row-tied. A failed READ still bails
 * immediately: it yields no id range to step over, and a read that cannot run
 * is by construction not about any one chunk's rows.
 *
 * Chunking is kept even though one unbounded UPDATE would be fewer round trips.
 * A single shared `updated_at` stamps the whole healed set onto one timestamp,
 * and the sync cursor then carries that entire tied-top group: it persists the
 * ids in `observedIdsAtTopUpdatedAt` and, on every incremental tick until the
 * watermark advances, expands them into positional `id NOT IN ($2, $3, …)`
 * placeholders (`sync-source.ts` `listUpdatedSessionCursorRows`). Over a
 * corpus-sized heal that is a per-tick query the width of the corpus, and past
 * `MAX_OBSERVED_TOP_IDS` (5000) the persisted set is dropped entirely, so a
 * restart re-enumerates the whole group. Staggering per chunk holds that group
 * to `chunkSize`. NOTE: this is a cost argument, not a correctness one — the
 * overflow path is idempotently deduped by the outbox and the server (FEA-3473
 * G6), and `bumpSessionsUpdatedAt`'s own comment still calls the set "uncapped",
 * which has been stale since that cap landed.
 */
async function healHarness(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  input: {
    chunkSize: number;
    harness: string;
    mode: Exclude<BillingMode, "unknown">;
    passStart: string;
  }
): Promise<number> {
  let done = 0;
  let consecutiveFailures = 0;
  // NULL rather than "" so the first chunk's `id >` term is omitted from the
  // statement outright instead of leaning on an empty string sorting below
  // every real id.
  let lastBound: string | null = null;
  for (let chunkIndex = 0; ; chunkIndex++) {
    let candidates: { id: string }[];
    try {
      candidates = await selectHealChunkIds(prisma, input, lastBound);
    } catch (error) {
      log(healFailureMessage(input.harness, error));
      return done;
    }
    if (candidates.length === 0) {
      return done;
    }
    const ids = candidates.map((row) => row.id);
    // Take the max rather than the last element: `ORDER BY id ASC` already
    // guarantees it, and deriving it makes the bound strictly advance — and so
    // the loop terminate — without depending on that ordering surviving the
    // driver.
    const nextBound = ids.reduce((max, id) => (id > max ? id : max), ids[0]);
    // Per-chunk watermark, so a large heal cannot collapse the cursor's
    // top-timestamp group onto one instant (FEA-3485). Always >= `passStart`,
    // which is what makes every write monotone against the boundary predicate.
    const chunkNow = chunkWatermark(input.passStart, chunkIndex);
    try {
      const healedIds = await writeHealChunk(prisma, {
        chunkNow,
        ids,
        mode: input.mode,
        passStart: input.passStart,
      });
      done += healedIds.length;
      consecutiveFailures = 0;
    } catch (error) {
      log(healFailureMessage(input.harness, error));
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILED_CHUNKS) {
        return done;
      }
    }
    lastBound = nextBound;
  }
}
