import { isRecord } from "@/lib/type-guards";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";

/**
 * ISS-12017: the ONE place the vibe seed moves frozen golden-corpus time to
 * "now", so date-windowed screens (last 7 or 30 days) show the corpus.
 *
 * The shift is measured on whatever Desktop store the run was handed: the
 * newest `sessions.last_activity_at` lands at `now`. The vibe Desktop profile
 * prepares its store already shifted against the same `now`, so on that store
 * this evaluates to about zero, and on an unshifted store built from the raw
 * corpus it evaluates to the real shift. Rows read from a handed store are
 * therefore never shifted twice.
 */

export type CorpusShift = {
  readonly shiftMs: number;
  readonly nowMs: number;
};

/** How many timestamps the shift pulled back to `now` instead of the future. */
export type CorpusShiftTally = { clampedToNow: number };

const UTC_DAY_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const UTC_DAY_LENGTH = 10;

/**
 * Wire children of a mapped session (`perf-import-desktop-snapshot-mapping.ts`)
 * and the timestamp fields each carries. ISO fields are shifted and clamped;
 * epoch fields are shifted only, because an activity segment is a half-open
 * span the wire rejects once both ends clamp to the same instant.
 */
const CHILD_TIMESTAMP_FIELDS = [
  {
    key: "agents",
    iso: ["startedAt", "updatedAt", "endedAt", "awaitingInputSince"],
    epochMs: [],
  },
  { key: "events", iso: ["createdAt"], epochMs: [] },
  { key: "tokenEvents", iso: ["createdAt"], epochMs: [] },
  { key: "components", iso: ["firstInvokedAt", "lastInvokedAt"], epochMs: [] },
  { key: "activitySegmentRows", iso: [], epochMs: ["startMs", "endMs"] },
] as const;

const SESSION_ISO_FIELDS = [
  "startedAt",
  "updatedAt",
  "endedAt",
  "awaitingInputSince",
] as const;

/** `Date.parse(now) - Date.parse(newest corpus instant)`; throws on an unparseable instant. */
export function computeCorpusShiftMs(
  newestCorpusInstantIso: string,
  nowIso: string
): number {
  const newest = Date.parse(newestCorpusInstantIso);
  const now = Date.parse(nowIso);
  if (!(Number.isFinite(newest) && Number.isFinite(now))) {
    throw new Error(
      `cannot compute the corpus shift from newest='${newestCorpusInstantIso}' now='${nowIso}'`
    );
  }
  return now - newest;
}

/** The newest `sessions.last_activity_at` in a Desktop store; throws when the store has none. */
export function readNewestCorpusActivity(storePath: string): string {
  const db = openSnapshot(storePath);
  try {
    const row = db
      .prepare("SELECT MAX(last_activity_at) AS newest FROM sessions")
      .get();
    const newest = isRecord(row) ? row.newest : null;
    if (typeof newest !== "string" || newest.trim().length === 0) {
      throw new Error(
        `Desktop store '${storePath}' has no session with last_activity_at; it cannot anchor the corpus shift.`
      );
    }
    return newest;
  } finally {
    db.close();
  }
}

/**
 * Return a copy of one mapped wire session with every corpus timestamp moved by
 * `shift.shiftMs`. An ISO instant that would land after `now` is clamped to
 * `now` and tallied: the store builder stamps bookkeeping columns such as
 * `updated_at` with its own fixed clock (`REHEARSAL_NOW_ISO`), which is not
 * corpus time, and shifting it verbatim would date rows months ahead.
 */
export function shiftWireSession(
  session: Record<string, unknown>,
  shift: CorpusShift,
  tally: CorpusShiftTally
): Record<string, unknown> {
  const shifted: Record<string, unknown> = { ...session };
  for (const field of SESSION_ISO_FIELDS) {
    shifted[field] = shiftCorpusIso(session[field], shift, tally);
  }
  for (const child of CHILD_TIMESTAMP_FIELDS) {
    const rows = session[child.key];
    if (!Array.isArray(rows)) {
      continue;
    }
    shifted[child.key] = rows.map((row) =>
      shiftRecordFields(row, child.iso, child.epochMs, shift, tally)
    );
  }
  if (isRecord(session.sessionAnalytics)) {
    shifted.sessionAnalytics = shiftAnalytics(
      session.sessionAnalytics,
      shift,
      tally
    );
  }
  return shifted;
}

function shiftRecordFields(
  row: unknown,
  isoFields: readonly string[],
  epochFields: readonly string[],
  shift: CorpusShift,
  tally: CorpusShiftTally
): unknown {
  if (!isRecord(row)) {
    return row;
  }
  const shifted: Record<string, unknown> = { ...row };
  for (const field of isoFields) {
    shifted[field] = shiftCorpusIso(row[field], shift, tally);
  }
  for (const field of epochFields) {
    const value = row[field];
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      shifted[field] = value + shift.shiftMs;
    }
  }
  return shifted;
}

/**
 * `startedDay` is the stored UTC-day prefix of `startedAt` (Desktop's
 * `storedUtcDaySql`), so it is re-derived from the shifted instant rather than
 * shifted on its own.
 */
function shiftAnalytics(
  analytics: Record<string, unknown>,
  shift: CorpusShift,
  tally: CorpusShiftTally
): Record<string, unknown> {
  const startedAt = shiftCorpusIso(analytics.startedAt, shift, tally);
  const shifted: Record<string, unknown> = {
    ...analytics,
    startedAt,
    updatedAt: shiftCorpusIso(analytics.updatedAt, shift, tally),
  };
  const startedDay = analytics.startedDay;
  if (typeof startedDay === "string" && UTC_DAY_PREFIX.test(startedDay)) {
    const anchor =
      typeof startedAt === "string"
        ? startedAt
        : shiftCorpusIso(
            `${startedDay.slice(0, UTC_DAY_LENGTH)}T00:00:00.000Z`,
            shift,
            tally
          );
    if (typeof anchor === "string") {
      shifted.startedDay = anchor.slice(0, UTC_DAY_LENGTH);
    }
  }
  return shifted;
}

/**
 * Move one corpus ISO instant by the shift, clamping at `now`. Non-strings and
 * unparseable strings pass through untouched.
 */
export function shiftCorpusIso(
  value: unknown,
  shift: CorpusShift,
  tally: CorpusShiftTally
): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  const moved = parsed + shift.shiftMs;
  if (moved > shift.nowMs) {
    tally.clampedToNow += 1;
    return new Date(shift.nowMs).toISOString();
  }
  return new Date(moved).toISOString();
}
