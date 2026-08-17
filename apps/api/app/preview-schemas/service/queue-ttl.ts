/**
 * Merge-queue TTL policy for preview schemas (ISS-5343).
 *
 * A private internal of `app/preview-schemas/service.ts`, which stays the only
 * module routes consume. Split out per the nested-service pattern in
 * `apps/api/AGENTS.md` so the composition root does not carry every concern.
 */

const HOURS_PER_DAY = 24;

/**
 * TTL for merge-queue preview schemas, in hours.
 *
 * A `gh-readonly-queue/*` preview is dead the moment its merge group merges or
 * is ejected — minutes after the build — but its registry row keeps
 * `last_seen_at` fresh, so the ordinary 7-day TTL never sees it. At ~80–110
 * queue schemas a day that is unbounded catalog growth.
 *
 * 12h is safe against dropping a live build: `last_seen_at` is written once at
 * build time and Vercel's build ceiling is 45 minutes, so a queue schema this
 * old cannot still be building. A requeue re-runs `upsertSchemaRegistry` and
 * refreshes the timestamp, extending the window rather than racing it.
 */
export const FALLBACK_QUEUE_TTL_HOURS = 12;

/**
 * Resolves the merge-queue TTL from `process.env.PREVIEW_QUEUE_SCHEMA_TTL_HOURS`,
 * falling back to {@link FALLBACK_QUEUE_TTL_HOURS} when unset, non-numeric, or
 * non-positive. Read at call time so ops can raise it without a redeploy — the
 * rollback lever for ISS-5343.
 */
export function getQueueTtlHours(): number {
  const raw = process.env.PREVIEW_QUEUE_SCHEMA_TTL_HOURS;
  if (raw === undefined || raw === "") {
    return FALLBACK_QUEUE_TTL_HOURS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_QUEUE_TTL_HOURS;
}

/**
 * The queue TTL expressed in days, for `categorizeSchema`.
 *
 * `categorizeSchema` takes a plain `ttlDays` multiplier, so a sub-day TTL is
 * just a fraction — no second unit on the shared helper, and no churn for its
 * other caller (the ops CLI).
 */
export function getQueueTtlDays(): number {
  return getQueueTtlHours() / HOURS_PER_DAY;
}
