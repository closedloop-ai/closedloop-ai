/**
 * @file component-tombstone.ts
 * @description Single owner of the `agent_components` tombstone WRITE.
 *
 * ISS-6881. The component sync lane is a KEYSET lane: `listAgentComponentCursorRows`
 * (`../database/component-sync-source.ts`) pages by `(COALESCE(last_seen_at,''), id)`
 * and the desktop persists that pair as its durable cursor. So a mutation that must
 * re-enter the lane has to ADVANCE the ordering key — a write that touches only
 * `uninstalled_at` leaves the row wherever it already sat, and once the cursor has
 * paged past that position the tombstone is never selected again. The uninstall then
 * never reaches the cloud and org inventory/search keep presenting a removed
 * component as installed.
 *
 * Stamping the scan instant is NOT sufficient, because the cursor is a COMPOSITE
 * `(timestamp, id)` key and the lane runs concurrently with the scan. A scan stamps
 * one `now` across every row it writes, and each write is a separate awaited task, so
 * the lane can read and acknowledge a sibling row at `(now, idB)` in between. A
 * tombstone that then lands at `(now, idA)` with `idA <= idB` satisfies neither keyset
 * disjunct — `now > now` is false and `idA > idB` is false — and the
 * `uninstalled_at IS NULL` guard on every tombstone writer stops any later scan from
 * restamping it. The uninstall is omitted from cloud inventory permanently.
 *
 * {@link applyComponentTombstone} therefore does not stamp `now`. It derives an
 * ordering key STRICTLY GREATER than the scan instant, than every `last_seen_at`
 * currently in the table, AND than the component lane's DURABLE cursor position.
 * The derivation runs in the SAME write-queue task as the UPDATE, so no writer can
 * raise either floor between the two statements. `MAX(last_seen_at)` is an
 * index-tail read on the existing `idx_agent_components_last_seen`, not a scan.
 *
 * ISS-10027 — WHY THE TABLE MAXIMUM IS NOT A SUFFICIENT FLOOR. ISS-6881 argued that
 * the surviving-row maximum already dominates the cursor, because the lane only ever
 * advances onto a `(last_seen_at, id)` pair it read off a real row. That argument
 * rested on rows being tombstoned rather than DELETED, and they are not: rows are
 * physically removed by the skill-shadow phantom-command sweep
 * (`../database/skill-shadow-inventory-maintenance.ts`) and by migration
 * `0045_iss4778_phantom_command_backfill`. Delete the row the cursor is sitting on
 * while its `last_seen_at` was ahead of the clock — reachable, because the `+1ms`
 * chain walks the maximum forward and a backwards clock step leaves it there — and the
 * surviving maximum drops BELOW the persisted cursor. Every key derived from it then
 * lands at or behind that cursor, satisfies neither keyset disjunct, and the mutation
 * never re-enters the lane: the exact data-loss condition ISS-6881 and ISS-6905 exist
 * to close, reintroduced through the back door.
 *
 * So the cursor is read DIRECTLY, as a second floor, from `sync_state`. The component
 * lane's key space is target-scoped and revision-embedded
 * (`buildAgentComponentSyncSourceKey`), and the tombstone writers have no compute
 * target in hand, so the floor is the greatest `observed_top_updated_at` over EVERY
 * component-lane cursor row rather than one target's. That is deliberately
 * conservative and it is sound in the direction that matters: a key strictly above
 * every component-lane cursor is strictly above the particular one this device is
 * draining, and the cost of the extra headroom is a few milliseconds of ordering key.
 *
 * Keeping this in one owner is deliberate: the ordering-key advance had already been
 * derived once for the installed-plugin path and copied nowhere, so the pack-projected
 * and MCP writers silently lacked it (repo doctrine: SSOT drift by copy).
 */

import { COMPONENT_CURSOR_RANK_FLOOR } from "../../shared/component-cursor-rank-floor.js";
import { AGENT_COMPONENT_SYNC_SOURCE_KIND } from "../agent-sync/agent-session-sync-source.js";
import {
  componentCursorCanonicalRankSql,
  componentCursorRank,
} from "../database/component-cursor-rank.js";
import type { PrismaClient } from "../database/generated/client.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";

/** The write-queue capability {@link applyComponentTombstone} needs. */
export type ComponentTombstoneDb = Pick<DesktopPrisma, "write">;

/** The raw-read capability {@link reserveComponentOrderingKey} needs. */
export type ComponentOrderingKeyClient = Pick<PrismaClient, "$queryRawUnsafe">;

export type ComponentTombstoneInput = {
  /** When the component stopped being installed. Recorded as-is. */
  uninstalledAt: string;
  /**
   * The current scan instant. A FLOOR for the ordering key, never the key itself —
   * see the file header for why stamping it directly loses the race.
   */
  scanInstant: string;
  /** Predicate for the UPDATE. Numbers its own parameters from `$3`. */
  whereSql: string;
  /** Bindings for `whereSql`, in `$3`, `$4`, … order. */
  whereParams: readonly unknown[];
};

/** Smallest step that still separates two canonical ISO-8601 millisecond keys. */
const ORDERING_KEY_STEP_MS = 1;

/**
 * The byte-greatest RANKING KEY in the table — ISS-11327.
 *
 * Still a keyset POSITION rather than a measurement, so it still has to speak the
 * order the lane speaks; what changed is the order. ISS-11317 kept this read raw and
 * recorded the reason as "the consumer's own comparison is byte-wise", which was true
 * and is no longer: `listAgentComponentCursorRows` now pages on
 * `componentCursorCanonicalRankSql(last_seen_at)`. A raw `MAX` here would floor on a value the
 * lane never compares — the mirror image of the mistake that justification avoided —
 * and would disagree with the cursor floor below, leaving two floors ranking in
 * different orders.
 */
const HIGHEST_ORDERING_KEY_SQL = `SELECT MAX(${componentCursorCanonicalRankSql("last_seen_at")}) AS "highestKey" FROM agent_components`;

type HighestOrderingKeyRow = { highestKey: string | null };

/**
 * Every durable cursor belonging to the COMPONENT lane, whatever compute target or
 * payload revision minted it.
 *
 * `sync_state` is keyed by `source_key` across several unrelated writers — the
 * session lane's `agent_sessions:`, the artifact-marker touch sentinel's
 * `desktop_session_artifact_markers:` — whose `observed_top_updated_at` means
 * something else entirely and must not become a floor here. The trailing colon is
 * load-bearing rather than cosmetic: it is what keeps a future kind that merely
 * BEGINS with this one's name out of the match. Prefix-scoping a `sync_state` read
 * by kind is the idiom `../database/sync-cursor-state.ts` already uses for the
 * session lane, as a `startsWith` in TypeScript; the same scoping is expressed here
 * in SQL as a `GLOB` because the aggregate has to run in the database.
 *
 * `GLOB` and not `LIKE`: `LIKE` reads `_` as a single-character wildcard, and this
 * prefix contains one, so a `LIKE` pattern would silently widen the scan — the same
 * hazard `AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX` records for its own
 * key space. `AGENT_COMPONENT_SYNC_SOURCE_KIND` carries no `*`, `?` or `[`, so it
 * needs no escaping as a GLOB pattern.
 */
const COMPONENT_LANE_SOURCE_KEY_GLOB = `${AGENT_COMPONENT_SYNC_SOURCE_KIND}:*`;

/**
 * ISS-10027: every component-lane cursor position.
 *
 * A projection rather than an aggregate, because the fold happens in JS
 * ({@link highestCursorInLaneOrder}): `sync_state` holds one row per lane per compute
 * target and `source_key` is the table's primary key, so this is a handful of rows off
 * that index, and a JS fold can normalize a value an installed build wrote before
 * ISS-11327 without a second SQL expression.
 *
 * ISS-11327: the rows are RANKED before they are folded, through the same
 * `componentCursorRank` the lane's own predicate now uses. ISS-10027 deliberately read
 * them raw, and its reason was sound at the time — the lane compared stored bytes, so
 * a normalized reading would have floored on a value the lane never saw and left
 * {@link warnOnUnclearedFloor} inspecting different text than the strand happened in.
 * That reason inverted when the lane stopped comparing bytes: reading them raw is now
 * what would floor on a value the lane never compares. The invariant is unchanged —
 * this floor speaks whatever order the lane speaks — and so is its agreement with
 * {@link HIGHEST_ORDERING_KEY_SQL}, which ranks through the identical expression.
 *
 * `observed_top_updated_at` stores the lane's ranking key, so a first-run cursor is
 * the empty string rather than NULL. Both fall out of {@link parseOrderingInstant} as
 * `null` — the correct reading, since neither is a position a tombstone must outrank.
 */
const COMPONENT_LANE_CURSOR_SQL = `SELECT observed_top_updated_at AS "observedTopUpdatedAt"
     FROM sync_state
    WHERE source_key GLOB $1`;

type ComponentLaneCursorRow = { observedTopUpdatedAt: string | null };

/**
 * Apply a tombstone to every `agent_components` row matching `whereSql`.
 *
 * The read of the current maximum ordering key and the UPDATE that consumes it run
 * inside ONE {@link DesktopPrisma.write} task. That is the repo's existing write
 * serializer, and it is what makes this a single atomic read-modify-write rather than
 * a racy decomposition: no other writer can raise the maximum in between, so the key
 * this computes is still strictly the greatest when the UPDATE lands.
 *
 * Returns the number of rows tombstoned. Throws whatever the underlying write
 * throws; callers own their own logging and summary counters.
 */
export async function applyComponentTombstone(
  db: ComponentTombstoneDb,
  input: ComponentTombstoneInput
): Promise<number> {
  return await db.write(async (client) => {
    const orderingKey = await reserveComponentOrderingKey(
      client,
      input.scanInstant
    );
    const affected = await client.$executeRawUnsafe(
      buildComponentTombstoneSql(input.whereSql),
      input.uninstalledAt,
      orderingKey,
      ...input.whereParams
    );
    return typeof affected === "number" ? affected : 0;
  });
}

/**
 * Build the tombstone `UPDATE` for `agent_components`.
 *
 * Two instants are RESERVED, and they are separate on purpose:
 * - `$1` — when the component stopped being installed, recorded as-is.
 * - `$2` — the sync ORDERING KEY, from {@link nextComponentOrderingKey}. It is
 *   deliberately not the scan instant: the pack-projected writer carries an
 *   `agent_packs.uninstalled_at` from an earlier scan, and even the current instant
 *   ties with the sibling rows the same scan just wrote.
 *
 * A caller's `whereSql` numbers its own parameters from `$3`, and may also read
 * `$1`/`$2` when its predicate is scoped by the same instant (as the MCP absence
 * scan is).
 */
function buildComponentTombstoneSql(whereSql: string): string {
  return `UPDATE agent_components
             SET uninstalled_at = $1,
                 last_seen_at = $2
           WHERE ${whereSql}`;
}

/** Parse a stored ordering key, or `null` when it is not a usable instant. */
function parseOrderingInstant(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The ordering key a tombstone must take: strictly after `scanInstant`, after
 * `highestExistingKey` (the greatest `last_seen_at` in the table), and after
 * `highestCursorKey` (the furthest any component-lane cursor has been advanced).
 *
 * ISS-11327: both floors are expected already RANKED — the representation the lane
 * compares — because {@link warnOnUnclearedFloor} compares the minted key against
 * them with the lane's own `>`. {@link reserveComponentOrderingKey} is the production
 * caller and ranks both; a unit test may hand this raw text to exercise the
 * derivation's own boundary cases, where the parse is the only thing under test.
 *
 * `highestCursorKey` is REQUIRED rather than defaulted. A default would let a caller
 * omit the floor and still compile, which is precisely how ISS-10027 got here: the
 * cursor floor is not an enhancement the caller may decline, it is the second half of
 * the guarantee this function's name makes.
 *
 * Exported for direct unit coverage of the boundary cases (tie with the scan instant,
 * a table maximum ahead of the clock, a cursor ahead of BOTH, an absent or unparseable
 * value in either floor), which are exactly the states the race turns on.
 */
export function nextComponentOrderingKey(
  scanInstant: string,
  highestExistingKey: string | null,
  highestCursorKey: string | null
): string {
  const scanMs = parseOrderingInstant(scanInstant);
  if (scanMs === null) {
    // The caller's own clock is unusable. Nothing here can improve on it, and
    // fabricating an instant would be worse than passing it through unchanged.
    gatewayLog.warn(
      "component-tombstone",
      `unparseable scan instant ${JSON.stringify(scanInstant)}; tombstone ordering key left at the caller's value`
    );
    return scanInstant;
  }
  const floorsMs = [
    parseOrderingInstant(highestExistingKey),
    parseOrderingInstant(highestCursorKey),
  ].filter((ms): ms is number => ms !== null);
  const baseMs = Math.max(scanMs, ...floorsMs);
  const key = new Date(baseMs + ORDERING_KEY_STEP_MS).toISOString();
  warnOnUnclearedFloor(key, highestExistingKey, "stored maximum");
  warnOnUnclearedFloor(key, highestCursorKey, "durable lane cursor");
  return key;
}

/**
 * Read both ordering-key floors — the table's current maximum `last_seen_at` and the
 * component lane's durable cursor position — and derive the next key from them.
 *
 * MUST be called from inside the SAME {@link DesktopPrisma.write} task as the UPDATE
 * that consumes the returned key. That co-location is the whole atomicity argument:
 * the write queue is the repo's single writer, so no other writer can raise either
 * floor between these reads and that UPDATE, and the key is therefore still strictly
 * the greatest when the UPDATE lands. Calling it outside a write task decomposes an
 * atomic read-modify-write and reintroduces the race ISS-6881 closed.
 *
 * Shared by the tombstone WRITE above and the ISS-6906 repair pass
 * (`component-tombstone-repair.ts`), which advances the key of rows the PRE-ISS-6881
 * writers stranded. Both need the identical derivation, and deriving it twice is
 * exactly how the three tombstone writers came to disagree in the first place.
 */
export async function reserveComponentOrderingKey(
  client: ComponentOrderingKeyClient,
  scanInstant: string
): Promise<string> {
  const tableRows = await client.$queryRawUnsafe<HighestOrderingKeyRow[]>(
    HIGHEST_ORDERING_KEY_SQL
  );
  const cursorRows = await client.$queryRawUnsafe<ComponentLaneCursorRow[]>(
    COMPONENT_LANE_CURSOR_SQL,
    COMPONENT_LANE_SOURCE_KEY_GLOB
  );
  return nextComponentOrderingKey(
    scanInstant,
    tableRows[0]?.highestKey ?? null,
    highestCursorInLaneOrder(cursorRows)
  );
}

/**
 * Warn when the derived key fails to sort above a floor it was supposed to clear.
 *
 * Both floors reach here as RANKED keys (ISS-11327), which is what keeps this check
 * meaningful: `>` here is the same comparison `listAgentComponentCursorRows` will
 * perform, so a floor that passes here is one the lane will genuinely sort behind.
 * Handing this either floor in a representation the lane does not compare — raw text,
 * now that the lane ranks — would silence the exact case the warning exists to report.
 * `label` names WHICH floor was not cleared, because the two are read from different
 * tables and the remedy differs.
 *
 * ISS-11327 RETIRED the case ISS-10027 pinned here and left a narrower one. A
 * whole-second `…:00Z` floor used to outrank every `…:00.NNNZ` key derived from it
 * (`Z` 0x5A sorts after `.` 0x2E) and strand the tombstone; ranked, that floor and
 * that key are the same instant one millisecond apart and the key clears it. What
 * still cannot be cleared is a floor at the far end of the representable range: a
 * key past year 9999 renders as the extended form `+10000-…`, and `+` 0x2B sorts
 * below every 4-digit year, so the tombstone genuinely does not re-enter the lane.
 * That is still a corrupt row rather than a condition to paper over — the uninstall
 * gets the best key available and the anomaly is surfaced.
 *
 * A floor that carries NO readable instant no longer arrives here at all: it ranks to
 * {@link COMPONENT_CURSOR_RANK_FLOOR} and is reported by its own reader, which holds
 * the raw value this function would only have been able to describe as "not cleared".
 */
function warnOnUnclearedFloor(
  key: string,
  floor: string | null,
  label: string
): void {
  if (floor === null || key > floor) {
    return;
  }
  gatewayLog.warn(
    "component-tombstone",
    `component ordering key ${key} does not sort above the ${label} ${JSON.stringify(floor)}; the tombstone may not re-enter the sync lane`
  );
}

/**
 * The furthest-advanced cursor among the component lane's `sync_state` rows, by the
 * ordering the LANE uses.
 *
 * Still folded in TEXT order rather than by parsed instant, and for the same reason
 * as before: the value is a keyset position, so the position a key must clear is the
 * one the lane itself calls furthest. ISS-11327 changed only what that text IS — each
 * row is read through {@link componentCursorRank} first, which is exactly what the
 * lane's predicate compares, so the two cannot disagree about which cursor is ahead.
 * Ranked keys are fixed-width canonical text, so a byte fold over them IS an instant
 * fold; folding raw text would be the mixed-spelling hazard this ticket removed.
 *
 * A NULL contributes nothing, and so does a value carrying no readable instant: both
 * rank to {@link COMPONENT_CURSOR_RANK_FLOOR}, which is the lane's first-run position
 * and therefore not a position a tombstone must outrank.
 */
function highestCursorInLaneOrder(
  rows: readonly ComponentLaneCursorRow[]
): string | null {
  let highest: string | null = null;
  for (const row of rows) {
    const stored = row.observedTopUpdatedAt;
    const position = componentCursorRank(stored);
    if (position === COMPONENT_CURSOR_RANK_FLOOR) {
      reportUnreadableCursorPosition(stored);
      continue;
    }
    if (highest === null || position > highest) {
      highest = position;
    }
  }
  return highest;
}

/**
 * Report a persisted lane cursor that is present but carries no readable instant.
 *
 * ISS-11327: such a value contributes no floor, so without this it would drop out of
 * the derivation silently — and a cursor nothing can rank is exactly the corrupt-row
 * condition ISS-10027 added {@link warnOnUnclearedFloor} to surface. Named here
 * instead, because this is the only frame that still holds the raw stored text.
 *
 * The lane's own first-run position is the empty string and a legacy row may be NULL;
 * neither is corrupt, so neither is reported.
 */
function reportUnreadableCursorPosition(stored: string | null): void {
  if (stored === null || stored === COMPONENT_CURSOR_RANK_FLOOR) {
    return;
  }
  gatewayLog.warn(
    "component-tombstone",
    `durable lane cursor ${JSON.stringify(stored)} carries no readable instant; it cannot floor the tombstone ordering key`
  );
}
