/**
 * @file component-tombstone-repair.ts
 * @description ISS-6906 — the convergent repair for `agent_components` rows that the
 * PRE-ISS-6881 collector tombstoned.
 *
 * ── What ISS-6881 fixed, and what it could not ────────────────────────────────
 * ISS-6881 made every tombstone WRITE advance the component-sync lane's ordering
 * key (`component-tombstone.ts`), so a NEW uninstall re-enters the keyset lane
 * (`listAgentComponentCursorRows`, which pages by `(COALESCE(last_seen_at,''), id)`)
 * and reaches the cloud. It could not repair the rows already tombstoned by the old
 * writers: those sit at whatever ordering key they had while INSTALLED, behind the
 * persisted cursor, and every tombstone writer is guarded by `uninstalled_at IS
 * NULL`, so no later scan can ever restamp them. The uninstall is never selected
 * again and cloud inventory/search keep presenting a removed component as installed —
 * indefinitely, on every desktop that removed a component before that build. That
 * boundary was pinned as an explicit KNOWN LIMITATION test on PR #5201; this pass
 * closes it, and that test now asserts the repair instead.
 *
 * ── Which rows are stranded, and which must be left alone ─────────────────────
 * The discriminator is the ROW ITSELF, not a marker column, a migration high-water
 * mark, or a build stamp:
 *
 *   - Every CORRECT (post-ISS-6881) tombstone has `last_seen_at > uninstalled_at`.
 *     The writers record `uninstalled_at` as-is and take the ordering key from
 *     {@link reserveComponentOrderingKey}, which returns a key strictly greater than
 *     the scan instant, the table maximum, and the component lane's durable cursor
 *     position (ISS-10027) — and `uninstalled_at` is always at
 *     or before that scan instant (the MCP and installed-plugin writers pass the scan
 *     instant itself; the pack-projected writer passes an EARLIER instant its pack
 *     was retired at).
 *   - Every STRANDED (pre-fix) tombstone has `last_seen_at <= uninstalled_at`, or a
 *     legacy `NULL`. The old writers touched only `uninstalled_at`, leaving the key
 *     at the last instant the row was observed INSTALLED — which necessarily precedes
 *     the instant it stopped being installed.
 *
 * So {@link STRANDED_TOMBSTONE_SQL} selects exactly the stranded population and
 * excludes every correctly-delivered one. That exclusion is the property that makes
 * this pass safe to ship rather than merely convergent: a sweep that re-keyed every
 * tombstoned row would re-emit uninstalls the cloud already has, on a lane whose whole
 * point is that it only carries what changed.
 *
 * ── Why it is idempotent, without a marker table ──────────────────────────────
 * The repair writes a key strictly above the table maximum, the durable
 * component-lane cursor, and its own scan instant, and only to rows whose
 * `uninstalled_at` that key clears (see
 * {@link REPAIR_CHUNK_SQL}). A repaired row therefore satisfies
 * `last_seen_at > uninstalled_at` and stops matching the selection predicate — the
 * second run selects nothing and writes nothing, so the lane is entered exactly once
 * per stranded row. The same convergence is why this can live on the boot chain (see
 * `boot-maintenance.ts`) rather than in a one-shot migration: a device that upgrades,
 * a device restored from a backup, and a device whose repair was interrupted mid-pass
 * all converge on the next boot.
 *
 * Convergence is NOT what makes the drain terminate, though. The chunk loop is a
 * KEYSET over `id`, exactly as `billing-mode-heal.ts` is, so it walks each row at most
 * once per pass and ends when the keyset runs out — whether or not a given row's write
 * landed. Draining statelessly and relying on the predicate to empty would restart at
 * the head of the table on every chunk (that pass's own history records the resulting
 * `n + 2n + … + N` walk) and, worse, would spin forever on any row the pass turns out
 * to be unable to repair.
 *
 * ── The ordering key is the repair's OWN scan instant ─────────────────────────
 * The key is derived from `new Date().toISOString()` at the moment the chunk runs,
 * never from the row's historical `uninstalled_at`. Reusing the historical instant
 * would file the tombstone at a position the cursor has already passed — the exact
 * failure this repairs — and would also assert that the lane saw the row then, which
 * it did not. `uninstalled_at` is NOT rewritten: when the component stopped being
 * installed is a fact about the component, and the cloud reads it.
 *
 * ── Rows this pass refuses to repair ──────────────────────────────────────────
 * A row whose stored `uninstalled_at` does not sort BELOW the reserved key — a
 * corrupt instant in the future, or a non-canonical spelling that outranks every
 * canonical ISO-8601 key as TEXT — cannot be converged: re-keying it would leave it
 * still matching the predicate, so the pass would re-emit it to the cloud on every
 * boot forever. Such a row is left untouched and REPORTED rather than half-repaired
 * or silently churned, the same call `billing-mode-heal.ts` makes for a session it
 * cannot classify.
 *
 * A row whose timestamp is not a canonical REAL INSTANT is refused for a different
 * reason and reported separately. The classifier compares two stored TEXT values,
 * which SQLite orders byte-wise, and a whole-second `…:00Z` sorts above `…:00.500Z`
 * while being the earlier instant — so an unguarded comparison would read a stranded
 * row as delivered and skip it silently. Shape is necessary but NOT sufficient: the
 * canonical glob's fields are bare `[0-9]` classes, so an impossible value like
 * `2025-13-01T00:00:00.000Z` clears it, and repairing such a row would ship an
 * `uninstalled_at` the cloud's `isoDateSchema` rejects — dead-lettering the batch it
 * rides in. Both operands go through the canonical glob PLUS `isRealInstantSql`, and what it rejects
 * is counted, not assumed either way.
 *
 * ── Residual, inherited not introduced ────────────────────────────────────────
 * Like the ISS-6881 write it mirrors, this depends on the local clock being
 * MONOTONIC across boots. Since ISS-10027 the key is
 * `max(now, table maximum, durable component-lane cursor) + 1ms`, so a clock that
 * jumps backwards still yields a key above both stored floors — including the case
 * that drove ISS-10027, where a physical DELETE drops the table maximum below the
 * cursor. What remains unsolved is the TEXT-ordering hazard: a stored NON-CANONICAL
 * value — a `last_seen_at` elsewhere in the table, or the lane's own persisted
 * cursor, which `sync-cursor-state.ts` writes verbatim — can sort above every
 * canonical ISO-8601 key as TEXT and hold the reserved key below it. No key this
 * mints can clear such a floor, because every key it mints is `toISOString()` and a
 * whole-second `…:00Z` outranks all of them. Both floors are therefore read RAW and
 * compared as the lane compares them, so `nextComponentOrderingKey` WARNS on exactly
 * that rather than folding it out of view. This pass does not solve clock
 * monotonicity and does not claim to.
 */

import type { DesktopPrisma } from "../database/prisma-client.js";
import {
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  isRealInstantSql,
} from "../database/session-timestamp-form.js";
import { reserveComponentOrderingKey } from "./component-tombstone.js";

/** The capabilities {@link repairStrandedComponentTombstones} needs. */
export type ComponentTombstoneRepairDb = Pick<DesktopPrisma, "read" | "write">;

/**
 * The stranded population, as one SQL fragment used by the chunk's selection, its
 * write-side re-assertion, and the closing remainder count.
 *
 * `last_seen_at <= uninstalled_at` (not `<`) so a row whose two instants TIE is
 * repaired: a tie means the key was never advanced past the uninstall, which is the
 * stranding condition, and a correct write always lands strictly above.
 *
 * BOTH stored operands must be a canonical REAL INSTANT, because this comparison is
 * the classifier the whole pass turns on and SQLite compares TEXT BYTE-WISE. A
 * whole-second `…:00Z` sorts ABOVE `…:00.500Z` (`Z` 0x5A > `.` 0x2E) while being the
 * EARLIER instant, so an uncovered comparison would read a genuinely stranded row as
 * already-delivered and skip it forever — silently, which is the worse half.
 *
 * ISS-6906 (review): the fixed-width glob alone was the wrong test, because every one
 * of its fields is a bare `[0-9]` class — `2025-13-01T00:00:00.000Z` has the expected
 * width and is not a date. Admitting it here does not merely misclassify a row, it
 * SHIPS it: the repair re-keys it as successfully repaired, the component lane then
 * sends the unchanged `uninstalled_at`, and the cloud's `isoDateSchema` rejects it
 * because `Date.parse` is non-finite — turning the intended repair into a
 * permanently rejected batch while inventory stays stale. `isCanonicalRealInstantSql`
 * is the shape test AND the value test, and a row it rejects is not classified here
 * at all; it is counted by {@link UNREADABLE_TOMBSTONE_SQL} and reported.
 */
const STRANDED_TOMBSTONE_SQL = `uninstalled_at IS NOT NULL
       AND uninstalled_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
       AND (${isRealInstantSql("uninstalled_at")})
       AND (last_seen_at IS NULL
            OR (last_seen_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
                AND (${isRealInstantSql("last_seen_at")})
                AND last_seen_at <= uninstalled_at))`;

/**
 * Tombstoned rows carrying a timestamp this pass refuses to reason about.
 *
 * The exact complement of the readability guards above, NOT of the whole stranded
 * predicate: a correctly-delivered tombstone is readable and excluded here. These
 * rows may or may not be stranded — that is exactly what cannot be determined — so
 * they are reported rather than guessed at in either direction. Both halves call the
 * SAME predicate the stranded classifier calls, so the two cannot drift into a gap
 * where a row is neither repaired nor counted.
 */
const UNREADABLE_TOMBSTONE_SQL = `uninstalled_at IS NOT NULL
       AND (NOT (uninstalled_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
                 AND (${isRealInstantSql("uninstalled_at")}))
            OR (last_seen_at IS NOT NULL
                AND NOT (last_seen_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
                         AND (${isRealInstantSql("last_seen_at")}))))`;

/**
 * One chunk's candidate ids, past the keyset bound.
 *
 * Emitted CONDITIONALLY, for the reason `billing-mode-heal.ts` documents at length:
 * SQLite plans at PREPARE time, so a `($n IS NULL OR id > $n)` form references no
 * column the planner can range over and degrades to a full scan. The first chunk omits
 * the term outright; later chunks carry a bare `id > $1`.
 */
function chunkSelectSql(hasKeysetBound: boolean): string {
  const keysetSql = hasKeysetBound ? "\n       AND id > $1" : "";
  const limitParam = hasKeysetBound ? "$2" : "$1";
  return `SELECT id
      FROM agent_components
     WHERE ${STRANDED_TOMBSTONE_SQL}${keysetSql}
     ORDER BY id ASC
     LIMIT ${limitParam}`;
}

/**
 * The repair UPDATE for one chunk's ids.
 *
 * `$1` is the reserved ordering key; the ids follow from `$2`. `uninstalled_at` is
 * deliberately absent from the SET list — the repair moves a row's position in the
 * sync lane and nothing else about it.
 *
 * Two predicates guard the write, and neither is redundant:
 *  - the stranded predicate is RE-ASSERTED rather than trusted from the read that
 *    chose these ids, so a live writer that settled a row in between makes the write
 *    a no-op for that row instead of re-keying something already correct;
 *  - `uninstalled_at < $1` is the REPAIRABILITY condition. A row this key cannot
 *    clear would still match the stranded predicate after the write, so re-keying it
 *    would ship the same uninstall again on every boot. It is skipped here and
 *    counted by {@link reportRepairRemainder}.
 */
function repairChunkSql(idCount: number): string {
  const placeholders = Array.from(
    { length: idCount },
    (_, index) => `$${index + 2}`
  ).join(", ");
  return `UPDATE agent_components
        SET last_seen_at = $1
      WHERE id IN (${placeholders})
        AND ${STRANDED_TOMBSTONE_SQL}
        AND uninstalled_at < $1`;
}

/**
 * The two populations a completed pass owes the operator, in one read: rows it
 * classified as stranded but could not converge, and rows it could not classify.
 */
const REPAIR_REMAINDER_SQL = `SELECT
       SUM(CASE WHEN ${STRANDED_TOMBSTONE_SQL} THEN 1 ELSE 0 END) AS "remaining",
       SUM(CASE WHEN ${UNREADABLE_TOMBSTONE_SQL} THEN 1 ELSE 0 END) AS "unreadable"
      FROM agent_components`;

/**
 * Rows re-keyed per statement.
 *
 * A bound rather than a batching optimisation: `agent_components` rows carry the
 * full definition body, so an unbounded UPDATE over a large stranded set would hold
 * the single SQLite writer for the whole rewrite. The component-sync cursor is a pure
 * keyset over `(last_seen_at, id)` with no tied-top id set to expand, so — unlike the
 * session lane — sharing one instant across a chunk costs the cursor nothing, and the
 * chunk width is free to be about write duration alone.
 */
const COMPONENT_TOMBSTONE_REPAIR_CHUNK = 200;

/**
 * Consecutive failed chunk WRITES tolerated before the pass gives up for this boot.
 *
 * A single failure is skipped rather than fatal — the pass is convergent, so a row it
 * did not repair still matches next boot, and stepping over the chunk keeps one bad
 * row from head-of-line blocking the healthy tail on every boot. The cap is what stops
 * that tolerance from turning a lane-wide failure (the store is locked, the disk is
 * full) into a corpus-length walk of failing writes.
 */
const MAX_CONSECUTIVE_FAILED_CHUNKS = 3;

function repairFailureMessage(error: unknown): string {
  return `component tombstone repair failed (ISS-6906): ${error instanceof Error ? error.message : String(error)}`;
}

/** Read one chunk of stranded ids, ascending, past `bound`. */
function selectChunkIds(
  db: ComponentTombstoneRepairDb,
  chunkSize: number,
  bound: string | null
): Promise<{ id: string }[]> {
  const sql = chunkSelectSql(bound !== null);
  return db.read((reader) =>
    bound === null
      ? reader.$queryRawUnsafe<{ id: string }[]>(sql, chunkSize)
      : reader.$queryRawUnsafe<{ id: string }[]>(sql, bound, chunkSize)
  );
}

/**
 * Re-key one chunk of stranded tombstones, atomically.
 *
 * The ordering-key reservation and the UPDATE that consumes it run inside ONE
 * {@link DesktopPrisma.write} task, which is the repo's single write serializer — so
 * this is a genuine read-modify-write, not a racy decomposition, and the key still
 * clears every floor it was derived from when the UPDATE lands.
 *
 * Every row in the chunk therefore lands at ONE key strictly above the whole table
 * AND above the lane's durable cursor, so the lane is strictly behind all of them,
 * for every id. The cursor is floored EXPLICITLY rather than inferred from the table:
 * ISS-10027 retired the argument that the table maximum alone dominates it — that the
 * lane only ever advances onto a `(last_seen_at, id)` pair it read off a real row —
 * because rows are physically DELETED, so the pair the cursor sits on need not
 * survive. That is why a batch UPDATE is safe here where a per-row loop stamping one
 * shared `now` would not be: the ISS-6881 same-instant/smaller-id race needs two
 * writes with a lane drain between them, and there is no drain inside one statement.
 *
 * Returns the number of rows actually re-keyed, which is at most `ids.length`.
 */
function repairChunk(
  db: ComponentTombstoneRepairDb,
  ids: readonly string[]
): Promise<number> {
  return db.write(async (client) => {
    const orderingKey = await reserveComponentOrderingKey(
      client,
      new Date().toISOString()
    );
    const affected = await client.$executeRawUnsafe(
      repairChunkSql(ids.length),
      orderingKey,
      ...ids
    );
    return typeof affected === "number" ? affected : 0;
  });
}

/** The unconverged and unclassifiable tombstone counts, after a complete drain. */
type RepairRemainderRow = {
  remaining: number | bigint | null;
  unreadable: number | bigint | null;
};

/**
 * `SUM(...)` over an empty table is NULL, and a driver may hand back a bigint. Anything
 * that is not a finite number is reported as 0 rather than as a fabricated count.
 */
function remainderCount(value: number | bigint | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Report what a COMPLETE drain left behind: rows classified as stranded that no
 * reservable key could clear, and rows whose timestamps this pass would not compare.
 *
 * Only called when the drain ran to exhaustion. After a failure bail the remainder is
 * dominated by rows the pass never attempted, and reporting those as unrepairable
 * would be a plausible-but-wrong number.
 */
async function reportRepairRemainder(
  db: ComponentTombstoneRepairDb,
  log: (message: string) => void
): Promise<void> {
  let rows: RepairRemainderRow[];
  try {
    rows = await db.read((reader) =>
      reader.$queryRawUnsafe<RepairRemainderRow[]>(REPAIR_REMAINDER_SQL)
    );
  } catch (error) {
    log(repairFailureMessage(error));
    return;
  }
  const remaining = remainderCount(rows[0]?.remaining);
  if (remaining > 0) {
    log(
      `component tombstone repair (ISS-6906): ${remaining} tombstone(s) could not be re-entered into the component sync lane — their uninstalled_at does not sort below a current ordering key, so cloud inventory may still show them installed`
    );
  }
  const unreadable = remainderCount(rows[0]?.unreadable);
  if (unreadable > 0) {
    log(
      `component tombstone repair (ISS-6906): ${unreadable} tombstone(s) carry a timestamp that is not a canonical real instant and were not classified — the sync lane orders these values as TEXT, so whether they reached the cloud cannot be determined here`
    );
  }
}

/**
 * Re-enter every stranded uninstall into the component-sync lane, exactly once.
 *
 * Background/boot pass — never throws into the caller. Returns how many rows were
 * repaired so the caller (and the tests) can assert the second run is a no-op rather
 * than merely that it did not throw.
 */
export async function repairStrandedComponentTombstones(
  db: ComponentTombstoneRepairDb,
  log: (message: string) => void,
  chunkSize: number = COMPONENT_TOMBSTONE_REPAIR_CHUNK
): Promise<number> {
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let repaired = 0;
  let consecutiveFailures = 0;
  // NULL rather than "" so the first chunk's `id >` term is omitted from the
  // statement outright instead of leaning on an empty string sorting below every
  // real id.
  let lastBound: string | null = null;
  let drained = false;
  for (;;) {
    let candidates: { id: string }[];
    try {
      candidates = await selectChunkIds(db, safeChunkSize, lastBound);
    } catch (error) {
      // A failed READ yields no id range to step over, so there is nothing to skip
      // past: bail rather than re-issue the identical statement.
      log(repairFailureMessage(error));
      break;
    }
    if (candidates.length === 0) {
      drained = true;
      break;
    }
    const ids = candidates.map((row) => row.id);
    // Derive the bound rather than taking the last element: `ORDER BY id ASC`
    // already guarantees it, and deriving it makes the bound strictly advance — and
    // so the loop terminate — without depending on that ordering surviving the
    // driver.
    const nextBound = ids.reduce((max, id) => (id > max ? id : max), ids[0]);
    try {
      repaired += await repairChunk(db, ids);
      consecutiveFailures = 0;
    } catch (error) {
      log(repairFailureMessage(error));
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILED_CHUNKS) {
        break;
      }
    }
    // Advances from the READ whether or not the write landed, so one failing chunk
    // costs only its own rows instead of stranding the healthy tail behind it.
    lastBound = nextBound;
  }
  if (repaired > 0) {
    log(
      `component tombstone repair complete (ISS-6906): re-entered ${repaired} stranded uninstall(s) into the component sync lane`
    );
  }
  if (drained) {
    await reportRepairRemainder(db, log);
  }
  return repaired;
}
