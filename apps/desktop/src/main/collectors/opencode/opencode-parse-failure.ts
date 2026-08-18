/**
 * @file opencode-parse-failure.ts
 * @description ISS-5238 (F1): classify a throw raised while parsing ONE session
 * row out of the foreign `opencode.db`, and carry the resulting per-session
 * drops out of the batch load.
 *
 * OpenCode is a BATCH harness, so `loadOpencodeSessionsFromDb` reads the whole
 * store in one pass and the engine's retry design keys off whether that pass
 * THREW. `collector-manager-source-parse.ts:markSeenOnThrow` deliberately does
 * NOT mark a batch collector seen on a throw, precisely so a failed read is
 * retried. Swallowing every throw inside the parser defeated that: the parse
 * resolved with a SHORT list, `markSourceImported` advanced the DB fingerprint,
 * and the missing session froze out until the file's mtime/size moved again.
 *
 * So the line drawn here is explicit, and it is drawn on whether the failure can
 * PLAUSIBLY GO AWAY on its own — not on who raised it. `node:sqlite` stamps every
 * error it raises with a numeric SQLite result code, and those codes already
 * separate the two:
 *
 * - {@link OpencodeParseFailureKind.StoreUnreadable} — a RETRYABLE SQLite result
 *   code ({@link RETRYABLE_SQLITE_PRIMARY_CODES}: busy, locked, out of memory,
 *   interrupted, I/O error, protocol) or a closed handle. Nothing about the row is
 *   known to be wrong; we simply could not see it this tick, and the same read may
 *   well succeed on the next one. This PROPAGATES so the batch parse rejects, the
 *   fingerprint stays put, and the tick is retried.
 * - {@link OpencodeParseFailureKind.StoreCorrupt} — SQLite declared the DATABASE
 *   malformed (`SQLITE_CORRUPT`, `SQLITE_NOTADB`). Not retryable, but not a
 *   per-row verdict either (wongk review): dropping the "bad row" and importing
 *   its siblings would advance the fingerprint over a store SQLite says is
 *   malformed, presenting a partial corpus as a complete one. This PROPAGATES
 *   like a store failure; the no-progress case is the store retry/quarantine
 *   layer's problem, not this classifier's.
 * - {@link OpencodeParseFailureKind.MalformedRow} — everything else: an
 *   `InvalidTokenCountError` from a corrupt token counter, any other throw raised
 *   inside the parse of that row's own content, AND a DURABLE ROW-SCOPED SQLite
 *   code (`SQLITE_ERROR`, `SQLITE_TOOBIG`, …). All of
 *   those throw identically on every tick, so propagating them would wedge the
 *   ENTIRE corpus behind one bad row FOREVER — a batch collector's throw is never
 *   marked seen and there is no quarantine counter for throws, so nothing would
 *   ever let it through again. That is strictly worse than the bug being fixed
 *   here. The session is dropped instead — but reported on the monitored
 *   `collector opencode import failed: …` channel, and recorded in
 *   {@link OpencodeSessionLoad.droppedSessions} so downstream consumers can tell a
 *   short load from a complete one (see the materializer prune, ISS-5238 F3, and
 *   the subagent fold, F2).
 */
import { z } from "zod";
import type { NormalizedSession } from "../types.js";

/** `DatabaseSync`/`StatementSync` raise this when the handle is already closed. */
const INVALID_STATE_ERROR_CODE = "ERR_INVALID_STATE";

/**
 * Reduces an extended SQLite result code to its primary code. An extended code is
 * `primary + (sub << 8)`, so the primary code is the remainder mod 256 (written as
 * a modulo rather than a mask because `noBitwiseOperators` is an error here).
 */
const SQLITE_PRIMARY_CODE_MODULUS = 256;

/**
 * The SQLite primary result codes that mean "not right now", as opposed to "not
 * ever". Only these make a per-row read failure worth retrying. The
 * whole-database verdicts (`SQLITE_CORRUPT` 11, `SQLITE_NOTADB` 26) are handled
 * separately by {@link CORRUPT_SQLITE_PRIMARY_CODES}; every remaining code
 * (notably `SQLITE_ERROR` 1, `SQLITE_TOOBIG` 18) is a durable property of the ROW
 * and is classified as {@link OpencodeParseFailureKind.MalformedRow} so it cannot
 * wedge the corpus forever. Extended codes (e.g. `SQLITE_IOERR_READ` = 266) are
 * reduced to their primary code before the lookup.
 */
const RETRYABLE_SQLITE_PRIMARY_CODES: ReadonlySet<number> = new Set([
  5, // SQLITE_BUSY — the write lock was held past the 1s busy_timeout
  6, // SQLITE_LOCKED — a table lock inside the same connection
  7, // SQLITE_NOMEM — memory pressure
  9, // SQLITE_INTERRUPT — the operation was interrupted
  10, // SQLITE_IOERR — a disk I/O error
  15, // SQLITE_PROTOCOL — locking-protocol contention
]);

/**
 * The SQLite primary result codes that are a verdict on the whole DATABASE, not
 * on one row (wongk review). These are NOT retryable, but they must not be
 * demoted to {@link OpencodeParseFailureKind.MalformedRow} either: dropping the
 * "bad row" and importing its siblings would checkpoint a partial corpus over a
 * store SQLite has declared malformed, presenting missing sessions as absent
 * ones. They ABORT the load instead, leaving the fingerprint unadvanced; the
 * no-progress case belongs to the store retry/quarantine layer, not here.
 */
const CORRUPT_SQLITE_PRIMARY_CODES: ReadonlySet<number> = new Set([
  11, // SQLITE_CORRUPT — the database image is malformed
  26, // SQLITE_NOTADB — the file is encrypted, or is not a database at all
]);

/** How many characters of a raw cell value a diagnostic message may quote. */
const CELL_PREVIEW_MAX_CHARS = 64;

/**
 * The shape a `node:sqlite` error carries. `errcode` (the numeric SQLite result
 * code) is checked alongside `code` so the classification survives Node changing
 * the `code` string, and vice versa.
 */
const nodeErrorShapeSchema = z.object({
  code: z.string().optional(),
  errcode: z.number().optional(),
});

/** Which side refused: the STORE, or the ROW's own content. */
export const OpencodeParseFailureKind = {
  /** SQLite could not serve the read — retryable, must not be swallowed. */
  StoreUnreadable: "storeUnreadable",
  /** SQLite declared the DATABASE malformed — never a per-row verdict. */
  StoreCorrupt: "storeCorrupt",
  /** The row's content is unusable — durable, must not wedge the corpus. */
  MalformedRow: "malformedRow",
} as const;
export type OpencodeParseFailureKind =
  (typeof OpencodeParseFailureKind)[keyof typeof OpencodeParseFailureKind];

/** One session the batch load could not parse, and why. */
export type OpencodeDroppedSession = {
  /** The RAW opencode session id (no `opencode-` prefix). */
  sessionId: string;
  reason: string;
};

/**
 * The result of a batch load: the sessions that parsed, PLUS every session that
 * did not. A caller that prunes, checkpoints, or re-roots off this list must
 * treat a non-empty `droppedSessions` as "this is not the whole store" —
 * conflating it with "these sessions no longer exist" is what makes the
 * materializer delete a still-correct projection (ISS-5238 F3).
 */
export type OpencodeSessionLoad = {
  sessions: NormalizedSession[];
  droppedSessions: OpencodeDroppedSession[];
};

/**
 * Classify a throw raised while parsing one session row. See the file header for
 * why the line is drawn at "did SQLite refuse, or did we?".
 */
export function classifyOpencodeParseFailure(
  error: unknown
): OpencodeParseFailureKind {
  const parsed = nodeErrorShapeSchema.safeParse(error);
  if (!parsed.success) {
    return OpencodeParseFailureKind.MalformedRow;
  }
  const { code, errcode } = parsed.data;
  const primary =
    errcode === undefined ? undefined : errcode % SQLITE_PRIMARY_CODE_MODULUS;
  if (primary !== undefined && CORRUPT_SQLITE_PRIMARY_CODES.has(primary)) {
    return OpencodeParseFailureKind.StoreCorrupt;
  }
  const isRetryable =
    code === INVALID_STATE_ERROR_CODE ||
    (primary !== undefined && RETRYABLE_SQLITE_PRIMARY_CODES.has(primary));
  return isRetryable
    ? OpencodeParseFailureKind.StoreUnreadable
    : OpencodeParseFailureKind.MalformedRow;
}

/** One-line, log-safe description of a parse failure. */
export function describeOpencodeParseFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Log-safe preview of a raw SQLite cell for a diagnostic message. Foreign cell
 * content can be a multi-megabyte BLOB, so the TYPE is branched on BEFORE
 * anything is materialized — `String(value).slice(…)` would build the whole
 * string first and only then truncate.
 *
 * That ordering is not cosmetic. `node:sqlite` hands a BLOB column back as a
 * `Uint8Array`, and `String(uint8Array)` builds a comma-joined decimal string
 * several times the blob's size, which on a large `summary_*` cell can throw
 * `RangeError: Invalid string length` from inside the diagnostic itself. This
 * runs in the `report` callback of `resolveOpencodeDiffStats`, called from
 * `parseSessionRow`, so that throw would escape into `parseSessionRowSafely`,
 * classify as {@link OpencodeParseFailureKind.MalformedRow}, and DROP a session
 * whose only sin was an odd column type.
 */
export function describeOpencodeCell(value: unknown): string {
  if (value instanceof Uint8Array) {
    return `Uint8Array ${value.byteLength} bytes`;
  }
  if (typeof value === "string") {
    return `string ${JSON.stringify(value.slice(0, CELL_PREVIEW_MAX_CHARS))}`;
  }
  if (value !== null && typeof value === "object") {
    // Never invoke a foreign object's own `toString` — it is unbounded and can
    // itself throw. `Object.prototype.toString` is bounded and total.
    return `object ${Object.prototype.toString.call(value)}`;
  }
  // Primitives (and `null`): `String()` is O(1)-ish and cannot blow the heap.
  const preview = String(value).slice(0, CELL_PREVIEW_MAX_CHARS);
  return `${typeof value} ${JSON.stringify(preview)}`;
}

/**
 * Decide what a FAILED optional-column schema probe means. ISS-5238 (wongk
 * review): the probe used to swallow every throw and answer `false`, rendering a
 * failed read as a confident "this store has a legacy schema". A transient
 * `SQLITE_BUSY`/`SQLITE_IOERR` that clears before the following SELECT would
 * then drop every summary-derived diff stat for the WHOLE store — and because
 * the load resolves normally, `markSourceImported` advances the fingerprint and
 * that loss freezes in until the DB's mtime/size moves again. Same defect class
 * as F1, so it is split the same way:
 *
 * - RETRYABLE ({@link OpencodeParseFailureKind.StoreUnreadable}) — RETHROWS, so
 *   the batch load rejects, the fingerprint stays put, and the tick is retried.
 * - DURABLE ({@link OpencodeParseFailureKind.MalformedRow}) — this store's schema
 *   genuinely cannot be inspected and will fail identically on every tick, so
 *   propagating would wedge the corpus forever (a batch collector's throw is
 *   never marked seen). Falls back to the legacy shape, but SAYS SO on the
 *   monitored channel instead of passing the failure off as a legacy schema.
 *
 * Returns `false` — "treat as legacy" — or throws; it never returns `true`.
 */
export function resolveSummaryColumnProbeFailure(
  error: unknown,
  report: (message: string) => void
): false {
  if (opencodeParseFailureAbortsLoad(classifyOpencodeParseFailure(error))) {
    throw error;
  }
  report(
    `summary-column probe failed durably (${describeOpencodeParseFailure(error)}); falling back to the legacy schema, so summary_* diff stats are unavailable for this store`
  );
  return false;
}

/**
 * Does this failure abort the whole batch load, rather than drop one session?
 *
 * The single predicate both seams consult, so the "which failures escape the
 * parser" rule cannot drift between them. The `switch` is exhaustive on purpose:
 * a new {@link OpencodeParseFailureKind} member fails `tsc` here until its
 * escape behavior is decided, instead of silently defaulting to "drop the row".
 */
export function opencodeParseFailureAbortsLoad(
  kind: OpencodeParseFailureKind
): boolean {
  switch (kind) {
    // Nothing about the row is known to be wrong — the same read may well
    // succeed next tick, so never checkpoint a short list over it.
    case OpencodeParseFailureKind.StoreUnreadable:
      return true;
    // SQLite declared the DATABASE malformed. Importing this row's siblings and
    // advancing the fingerprint would present a partial corpus as a complete
    // one; the no-progress case belongs to the store retry/quarantine layer.
    case OpencodeParseFailureKind.StoreCorrupt:
      return true;
    // Durable and row-scoped: dropping it is what keeps one bad row from
    // wedging the entire corpus forever.
    case OpencodeParseFailureKind.MalformedRow:
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
