import { toLocalDateOnly } from "@/lib/date-only";

/**
 * The two primitives every daily-bucketed Insights series shares: running the
 * aggregate with a timezone fallback, and enumerating the day axis in the SAME
 * zone the database actually bucketed in.
 *
 * Extracted from `service.ts` (FEA-2745 / ISS-4987) so the session-analytics
 * rollups reuse the one implementation instead of re-deriving it. A second copy
 * is exactly how one chart ends up with a UTC fallback and a gap-filled axis
 * while its sibling has neither.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Run a daily timezone-bucketed aggregate, degrading to UTC bucketing when the
 * Postgres server rejects the requested zone. A requester `timeZone` is
 * validated only against Node/ICU (isValidTimeZone), so a zone ICU accepts but
 * the PG server's tzdata doesn't know (version skew) makes `AT TIME ZONE` raise
 * and would 500 the whole insights endpoint. Degrading the one chart to UTC —
 * matching the validator's "unknown zone → UTC" contract and the JS
 * `toLocalDateOnly` fallback — keeps it rendering. `runQuery` builds the SQL for
 * a given zone (`undefined` ⇒ bucket in UTC); the returned `bucketedZone` is the
 * zone the rows were actually keyed in, so callers enumerate day keys in the
 * SAME zone (otherwise UTC row keys wouldn't line up with local-zone point keys
 * near day boundaries and counts would be dropped or misattributed).
 */
export async function runDailyBucketedQuery<T>(
  requestedZone: string | undefined,
  runQuery: (zone: string | undefined) => Promise<T[]>
): Promise<{ rows: T[]; bucketedZone: string | undefined }> {
  try {
    return { rows: await runQuery(requestedZone), bucketedZone: requestedZone };
  } catch (error) {
    // A UTC query (no zone) can only fail for a real DB error, so don't swallow
    // it behind a pointless retry.
    if (!requestedZone) {
      throw error;
    }
    // Only degrade to UTC for timezone-specific Postgres errors (tzdata version
    // skew). Genuine DB failures (connection, permissions, syntax) propagate as
    // real errors rather than being silently swallowed.
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.toLowerCase().includes("time zone")) {
      throw error;
    }
    return { rows: await runQuery(undefined), bucketedZone: undefined };
  }
}

// FEA-2745: build a yyyy-MM-dd bucket key that labels each instant by the
// calendar day it falls on in `timeZone`. Undefined timeZone keeps the legacy
// UTC bucketing (fast path, no formatter). Mirrors the desktop localDayKey()
// contract so the two surfaces attribute the same activity to the same day.
export function makeDayKey(timeZone?: string): (date: Date) => string {
  // Reuses the shared per-timezone formatter cache (getDateOnlyFormatter) and
  // its UTC fallback so each chart bucket doesn't construct a fresh
  // Intl.DateTimeFormat. `en-CA` emits YYYY-MM-DD, matching toIsoDateOnly's
  // slice(0, 10) fallback for missing/invalid zones.
  return (date) => toLocalDateOnly(date, timeZone);
}

export function eachDayKey(
  start: Date,
  end: Date,
  timeZone?: string
): string[] {
  const toKey = makeDayKey(timeZone);
  const keys: string[] = [];
  // Anchor enumeration on the local calendar dates of the window edges, then
  // advance in UTC-midnight steps: date-only arithmetic is DST-free, so each
  // 24h step yields exactly one consecutive calendar day whose slice(0,10)
  // matches the toKey() labels above.
  const cursor = new Date(`${toKey(start)}T00:00:00.000Z`);
  const endDay = new Date(`${toKey(end)}T00:00:00.000Z`).getTime();
  while (cursor.getTime() <= endDay) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setTime(cursor.getTime() + MS_PER_DAY);
  }
  return keys;
}
