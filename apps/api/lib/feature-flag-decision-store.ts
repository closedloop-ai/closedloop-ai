import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

/**
 * ISS-8126 — the CROSS-INSTANCE half of a memoized flag gate's promise.
 *
 * ISS-7860's memo made one viewer's reads agree WITHIN one instance. `apps/api`
 * is serverless, so that is not the whole promise: two reads served by two cold
 * instances during a PostHog outage still resolved differently — one holding the
 * rollout basis, the other failing closed to API-billed — and the reader watched
 * the LOC/$ ratio change between two nearby page loads with nothing on screen to
 * say why. The memo cannot reach that; a cold instance has no last-known
 * decision to hold. This is the record it holds it in.
 *
 * WHY POSTGRES AND NOT REDIS. `@repo/redis` exists, but only `apps/relay` and
 * `apps/mcp` use it — both long-lived containers with a `REDIS_URL` already
 * provisioned. `apps/api` has no Redis binding, so choosing it would mean a NEW
 * external dependency on the serverless request path, provisioned per
 * environment, with its own availability to reason about. Postgres is already on
 * this path, already pooled, and already the thing every other `apps/api` read
 * depends on: if it is down, the request was not going to be served anyway. The
 * cost is one indexed primary-key read on an outage path and one upsert per
 * viewer per TTL per instance on the evaluated path — not per request, because
 * the memo in front of this absorbs those.
 *
 * WHAT THIS IS NOT. It is not a cache of the flag, and it is deliberately not
 * consulted when PostHog ANSWERS. PostHog stays authoritative, so flipping a
 * rollout still takes effect within the memo's TTL rather than being pinned by a
 * stored decision. This record is read on exactly one path: the fallback for an
 * evaluation that could not be made.
 *
 * FAIL-CLOSED IS UNCHANGED, and that is the point rather than a caveat. A
 * genuinely unanswered lookup — no local decision, and no fresh record here —
 * still resolves `false`. What this removes is the narrower case where a
 * decision for this viewer DID exist, on another instance, and the cold instance
 * could not see it.
 */

/** One viewer's stored gate decision, and when PostHog actually evaluated it. */
export type SharedFlagDecision = {
  value: boolean;
  /** Epoch ms of the EVALUATION, not of the write. */
  decidedAt: number;
};

/**
 * The narrow port the gate depends on, so a test can supply two gates one shared
 * store without a database and the production wiring can supply Postgres.
 */
export type SharedFlagDecisionStore = {
  /**
   * The stored decision, or `null` when there is none AND when the store could
   * not be read. Both are "no decision on record" to the caller, which is what
   * keeps a store outage on the fail-closed path instead of the throwing one.
   */
  read(flagKey: string, viewerKey: string): Promise<SharedFlagDecision | null>;
  /** Publish an EVALUATED decision. Never throws; a failed write is logged. */
  publish(
    flagKey: string,
    viewerKey: string,
    decision: SharedFlagDecision
  ): Promise<void>;
};

/**
 * Structured-log event for a store round trip that threw.
 *
 * Named on the same terms as the gates' `*_unavailable` keys so a flag-infra
 * failure is one searchable family rather than a per-call-site spelling. Unlike
 * those, this fires on a THROW only — a missing row is an ordinary answer, not
 * an incident.
 */
export const FEATURE_FLAG_DECISION_STORE_UNAVAILABLE_LOG_KEY =
  "feature_flag_decision_store_unavailable";

/**
 * How long a decision row is kept before the retention sweep deletes it.
 *
 * `viewerKey` is a request principal — the JSON pair of a Clerk id and our own
 * user id — so a row that can no longer be READ is an identity record with no
 * remaining purpose, and keeping it is retention for its own sake. A retired
 * flag stops being evaluated and a deleted user stops appearing in any
 * `viewerKey`, so neither is ever overwritten by a later publish; without a
 * sweep both persist forever.
 *
 * TWENTY-FOUR HOURS, and the number is bounded from below by a real constraint
 * rather than chosen freely: it must exceed every gate's `sharedDecisionTtlMs`,
 * because {@link SharedFlagDecisionStore.read}'s callers already discard a row
 * older than that window. Deleting rows past this cutoff therefore changes no
 * gate's answer — it removes rows that are unreadable by construction. The only
 * gate that opts in today uses one hour, so this leaves a 23-hour margin;
 * `feature-flag-decision-retention.test.ts` fails if a gate's window ever grows
 * past it rather than letting the sweep start deleting live decisions.
 */
export const FEATURE_FLAG_DECISION_RETENTION_MS = 86_400_000;

/** What one retention sweep did, for the cron route's log and response. */
export type FeatureFlagDecisionSweepResult = {
  deleted: number;
  cutoff: string;
};

export function createFeatureFlagDecisionStore(): SharedFlagDecisionStore {
  return {
    async read(flagKey, viewerKey) {
      try {
        const row = await withDb((db) =>
          db.featureFlagDecision.findUnique({
            where: { flagKey_viewerKey: { flagKey, viewerKey } },
            select: { value: true, decidedAt: true },
          })
        );
        if (!row) {
          return null;
        }
        return { value: row.value, decidedAt: row.decidedAt.getTime() };
      } catch (error) {
        // Swallowed rather than propagated: this read happens only because
        // PostHog already failed, and turning a second infrastructure failure
        // into a thrown request would take a whole Sessions page down to avoid
        // a divisor changing. `null` puts the caller back on its own fail-closed
        // default, which is the answer it would have given before this store
        // existed.
        log.error(FEATURE_FLAG_DECISION_STORE_UNAVAILABLE_LOG_KEY, {
          flagKey,
          operation: "read",
          error: parseError(error),
        });
        return null;
      }
    },

    async publish(flagKey, viewerKey, decision) {
      try {
        // Raw rather than `upsert` because the UPDATE arm is CONDITIONAL, and
        // Prisma's upsert cannot express that. Per apps/api/AGENTS.md
        // ("last-write-wins is not freshness-safe"), two instances evaluating
        // the same viewer concurrently can have their writes land in either
        // order, and the slower-but-older evaluation must not overwrite the
        // newer verdict — which is exactly how a viewer whose rollout was just
        // turned off would keep being served the stale ON.
        await withDb(
          (db) =>
            db.$executeRaw`
            INSERT INTO feature_flag_decisions
              (flag_key, viewer_key, value, decided_at, updated_at)
            VALUES (
              ${flagKey},
              ${viewerKey},
              ${decision.value},
              ${new Date(decision.decidedAt)},
              NOW()
            )
            ON CONFLICT (flag_key, viewer_key) DO UPDATE
              SET value = EXCLUDED.value,
                  decided_at = EXCLUDED.decided_at,
                  updated_at = NOW()
              WHERE feature_flag_decisions.decided_at <= EXCLUDED.decided_at
          `
        );
      } catch (error) {
        // A failed publish costs cross-instance agreement for this viewer until
        // the next evaluation, and nothing else. The decision was already
        // returned to the caller before this ran.
        log.error(FEATURE_FLAG_DECISION_STORE_UNAVAILABLE_LOG_KEY, {
          flagKey,
          operation: "publish",
          error: parseError(error),
        });
      }
    },
  };
}

/**
 * Delete decision rows whose EVALUATION predates the retention window.
 *
 * Keyed on `decidedAt` rather than `updatedAt`: the evaluation time is what
 * every read window is measured from, so it is the column that decides whether a
 * row is still capable of answering anything.
 *
 * Throws rather than swallowing, unlike the request-path methods above. This
 * runs on a cron, where a failure must surface as a failed job instead of a
 * silent stop to retention.
 */
export async function sweepExpiredFeatureFlagDecisions(
  now: number = Date.now()
): Promise<FeatureFlagDecisionSweepResult> {
  const cutoff = new Date(now - FEATURE_FLAG_DECISION_RETENTION_MS);
  const { count } = await withDb((db) =>
    db.featureFlagDecision.deleteMany({ where: { decidedAt: { lt: cutoff } } })
  );
  return { deleted: count, cutoff: cutoff.toISOString() };
}

/**
 * Delete every decision recorded for one flag.
 *
 * The deletion path for a RETIRED flag, whose rows no publish will ever
 * overwrite and no read will ever want again. Separate from the age-based sweep
 * because retiring a flag should not mean waiting out a retention window on
 * identity records nobody can use.
 */
export async function purgeFeatureFlagDecisions(
  flagKey: string
): Promise<number> {
  const { count } = await withDb((db) =>
    db.featureFlagDecision.deleteMany({ where: { flagKey } })
  );
  return count;
}
