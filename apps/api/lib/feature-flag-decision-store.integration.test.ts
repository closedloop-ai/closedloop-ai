import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { autoRollbackTransaction } from "@/__tests__/utils/db-helpers";
import {
  createFeatureFlagDecisionStore,
  FEATURE_FLAG_DECISION_RETENTION_MS,
  purgeFeatureFlagDecisions,
  sweepExpiredFeatureFlagDecisions,
} from "@/lib/feature-flag-decision-store";

/**
 * ISS-8126 — the store's own SQL, against a real Postgres.
 *
 * The gate suite next door proves what the GATE does with a shared record, using
 * a fake. What only a database can judge is the half the fake stands in for: a
 * composite-key upsert whose UPDATE arm is CONDITIONAL. That condition is not
 * decorative — per apps/api/AGENTS.md ("last-write-wins is not freshness-safe;
 * process-local single-flight does not protect separate serverless instances"),
 * two instances evaluating one viewer can have their writes land in either
 * order, and an older evaluation overwriting a newer verdict is precisely how a
 * viewer whose rollout was just turned OFF keeps being served the stale ON —
 * through the record that exists to keep instances agreeing.
 *
 * Most cases run in an auto-rollback transaction, so nothing survives the file.
 * The two cross-transaction cases cannot — an ambient transaction is exactly what
 * they have to be outside of — and clean up their committed rows in a `finally`.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const FLAG_KEY = "iss8126-store-test-flag";
const VIEWER_KEY = JSON.stringify(["clerk_alpha", "user_alpha"]);
const OTHER_VIEWER_KEY = JSON.stringify(["clerk_beta", "user_beta"]);
const OTHER_FLAG_KEY = "iss8126-store-test-other-flag";

/** Whole seconds, because the column is `TIMESTAMP(3)` and rounds. */
const EARLIER = Date.parse("2026-08-27T12:00:00.000Z");
const LATER = Date.parse("2026-08-27T12:05:00.000Z");

describeIfDb("featureFlagDecisionStore", () => {
  it("round-trips a published decision, preserving the evaluation time", async () => {
    await autoRollbackTransaction(async () => {
      const store = createFeatureFlagDecisionStore();

      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt: EARLIER,
      });

      // `decidedAt` must come back as the moment PostHog decided, not as the
      // moment the row was written: the gate's staleness window is measured
      // from it, and a write timestamp would silently extend every window by
      // however long the publish took.
      expect(await store.read(FLAG_KEY, VIEWER_KEY)).toEqual({
        value: true,
        decidedAt: EARLIER,
      });
    });
  });

  it("reports no decision on record for a viewer nobody has evaluated", async () => {
    await autoRollbackTransaction(async () => {
      const store = createFeatureFlagDecisionStore();

      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt: EARLIER,
      });

      // Keyed on (flag, viewer), so one viewer's decision must not answer for
      // another's — inheriting a stranger's decision would serve a
      // dark-launched basis to someone PostHog never enabled it for.
      expect(await store.read(FLAG_KEY, OTHER_VIEWER_KEY)).toBeNull();
      expect(await store.read("some-other-flag", VIEWER_KEY)).toBeNull();
    });
  });

  it("lets a newer evaluation replace an older one", async () => {
    await autoRollbackTransaction(async () => {
      const store = createFeatureFlagDecisionStore();

      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt: EARLIER,
      });
      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: false,
        decidedAt: LATER,
      });

      // The ordinary case: the rollout was turned off and a later evaluation
      // says so. If this did not overwrite, the gate would keep handing cold
      // instances a decision the flag service has already retracted.
      expect(await store.read(FLAG_KEY, VIEWER_KEY)).toEqual({
        value: false,
        decidedAt: LATER,
      });
    });
  });

  it("refuses to let an older evaluation overwrite a newer verdict, across independent transactions", async () => {
    // NOT wrapped in `autoRollbackTransaction`, and that is the point of this
    // case rather than an oversight. That helper puts every statement on ONE
    // ambient transaction, where the second publish sees the first as its own
    // uncommitted work — so the conflict is resolved against a row this session
    // wrote, and the `ON CONFLICT` recheck against a row COMMITTED BY SOMEBODY
    // ELSE, which is the only situation the guard exists for, never runs. The
    // docstring above says "two instances"; on one transaction there is one.
    //
    // Each `store.publish` outside a transaction is its own, so the older
    // evaluation below meets a genuinely committed newer verdict.
    const store = createFeatureFlagDecisionStore();
    try {
      // The newer verdict lands first and COMMITS — the slow instance's older
      // evaluation arrives afterwards, which is the ordering nothing in a
      // serverless deployment prevents.
      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: false,
        decidedAt: LATER,
      });
      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt: EARLIER,
      });

      // Asserted on BOTH columns. Checking only `value` would stay green if the
      // row were rewritten with the stale `decidedAt` and a coincidentally
      // equal value, which is the same write this guard exists to reject.
      expect(await store.read(FLAG_KEY, VIEWER_KEY)).toEqual({
        value: false,
        decidedAt: LATER,
      });
    } finally {
      // Committed rows need deleting by hand; nothing rolls back for this case.
      await purgeFeatureFlagDecisions(FLAG_KEY);
    }
  });

  it("keeps the newer verdict when the two publishes race, whichever lands first", async () => {
    // The case above pins a DETERMINISTIC order. This one runs the two writers
    // concurrently on separate pooled connections, which is what actually drives
    // PostgreSQL's speculative-insertion recheck: whichever transaction loses the
    // race on the primary key blocks, then re-reads the winner's committed row
    // and re-evaluates the `WHERE` against it.
    //
    // The assertion is order-INDEPENDENT because the invariant is: if the older
    // write lands first the newer overwrites it (`decided_at <= EXCLUDED`), and
    // if the newer lands first the older is refused. Either way the newer
    // verdict survives — so this is deterministic in outcome without pinning a
    // scheduling order the database is free to choose.
    const store = createFeatureFlagDecisionStore();
    try {
      await Promise.all([
        store.publish(FLAG_KEY, VIEWER_KEY, { value: false, decidedAt: LATER }),
        store.publish(FLAG_KEY, VIEWER_KEY, {
          value: true,
          decidedAt: EARLIER,
        }),
      ]);

      expect(await store.read(FLAG_KEY, VIEWER_KEY)).toEqual({
        value: false,
        decidedAt: LATER,
      });
    } finally {
      await purgeFeatureFlagDecisions(FLAG_KEY);
    }
  });

  it("re-publishing the same evaluation is idempotent", async () => {
    await autoRollbackTransaction(async () => {
      const store = createFeatureFlagDecisionStore();

      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt: EARLIER,
      });
      // `<=` rather than `<` in the upsert's WHERE, so a re-publish at the same
      // instant still lands. Two instances that evaluated in the same
      // millisecond agree by definition, and refusing the write would leave one
      // of them believing it had published when it had not.
      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt: EARLIER,
      });

      expect(await store.read(FLAG_KEY, VIEWER_KEY)).toEqual({
        value: true,
        decidedAt: EARLIER,
      });
    });
  });

  it("sweeps decisions past the retention window and keeps the rest", async () => {
    // The DELETION path for identity records nobody can read any more. A publish
    // only ever overwrites the row for a viewer it is currently evaluating, so a
    // retired flag and a deleted user are invisible to every write path there
    // is; without this sweep their `viewer_key` — a Clerk id paired with our own
    // user id — is retained forever.
    const store = createFeatureFlagDecisionStore();
    const now = Date.now();
    const expiredViewer = JSON.stringify(["clerk_expired", "user_expired"]);

    try {
      await store.publish(FLAG_KEY, expiredViewer, {
        value: true,
        // One second past the cutoff rather than a comfortable day, so a sweep
        // that deleted on some other predicate could not pass this by accident.
        decidedAt: now - FEATURE_FLAG_DECISION_RETENTION_MS - 1000,
      });
      await store.publish(FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt: now - 1000,
      });

      const result = await sweepExpiredFeatureFlagDecisions(now);

      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await store.read(FLAG_KEY, expiredViewer)).toBeNull();
      // The live decision survives. Without this the sweep could be truncating
      // the table and every assertion above would read exactly the same.
      expect(await store.read(FLAG_KEY, VIEWER_KEY)).toEqual({
        value: true,
        decidedAt: now - 1000,
      });
    } finally {
      await purgeFeatureFlagDecisions(FLAG_KEY);
    }
  });

  it("purges one retired flag's decisions and leaves other flags alone", async () => {
    // The other deletion path: retiring a gate should not mean waiting out a
    // retention window on records that can never be read again.
    const store = createFeatureFlagDecisionStore();
    const decidedAt = Date.parse("2026-08-27T12:30:00.000Z");

    try {
      await store.publish(FLAG_KEY, VIEWER_KEY, { value: true, decidedAt });
      await store.publish(OTHER_FLAG_KEY, VIEWER_KEY, {
        value: true,
        decidedAt,
      });

      expect(await purgeFeatureFlagDecisions(FLAG_KEY)).toBe(1);

      expect(await store.read(FLAG_KEY, VIEWER_KEY)).toBeNull();
      // Scoped to the flag and not to the viewer: retiring one gate must not
      // drop the decisions every other gate is still serving from.
      expect(await store.read(OTHER_FLAG_KEY, VIEWER_KEY)).toEqual({
        value: true,
        decidedAt,
      });
    } finally {
      await purgeFeatureFlagDecisions(FLAG_KEY);
      await purgeFeatureFlagDecisions(OTHER_FLAG_KEY);
    }
  });
});
