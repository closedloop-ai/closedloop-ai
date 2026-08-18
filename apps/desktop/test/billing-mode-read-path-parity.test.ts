/**
 * @file billing-mode-read-path-parity.test.ts
 * @description ISS-4878 acceptance. Pins the two LOCAL read paths called out in
 * the issue — `getSessionLedger` (Sessions usage fold) and the Branches usage
 * producers — against a PRE-EXISTING session row stamped `unknown` that is
 * NEVER re-imported, which is exactly the ~1,270-row population the macOS
 * Keychain detection fix (ISS-4869 / PR #4225) could not reach through the
 * import path.
 *
 * ── Coverage is taken at the PUBLIC layer the issue names ─────────────────────
 * ISS-4878's acceptance is stated against `shared-agent-sessions-api.ts` and
 * `shared-branches-api.ts`, so the cases below drive those two PUBLIC serving
 * functions — `getSharedAgentSessionUsage` and `getSharedBranchUsage` — with the
 * request shapes the usage cards actually issue, not only the lower-level
 * readers underneath them. That matters because each public function picks
 * BETWEEN producers, and the branch it picks by DEFAULT is not the one the
 * readers alone exercise:
 *
 *   - Sessions — for an ordinary usage request `getSharedAgentSessionUsage`
 *     prefers the O(grouped) SQL aggregate (`source.aggregateUsage` →
 *     `foldUsageAggregate`) and returns BEFORE `loadUsageSessions` is reached.
 *     The SQL groups on the RAW `s.billing_mode` column, so re-resolution for
 *     this population happens only in `foldUsageAggregate`'s per-group
 *     `resolveBillingModeForRow`. Covering `loadUsageSessions` alone would leave
 *     a misbucketing regression in that fold invisible.
 *   - Branches — `getSharedBranchUsage` reads from the per-(session, model)
 *     `token_usage` aggregate when NO date window is set, and from per-event
 *     `token_events` rows when one is (FEA-4270). Those are two separate
 *     producers with two separate billing-mode resolutions, so both are driven
 *     here through the public function.
 *
 * The row is inserted directly with `billing_mode = 'unknown'` and is never fed
 * through the importer, so nothing here depends on `write-core.ts`'s sticky
 * `CASE` re-stamp or on a `DATA_REVISION` rebuild having run. If either read
 * path ever goes back to reading the raw `sessions.billing_mode` column, the
 * subscription assertions below fail.
 *
 * ── What is, and is not, an INDEPENDENT cross-surface guard ───────────────────
 * Sessions and Branches resolve through two SEPARATE call sites
 * (`assembleSyncedSessions` → `resolveBillingModeForRow` in `sync-source.ts`,
 * versus `resolveBranchRowBillingMode` in `branch-reads.ts`), so comparing them
 * is a genuine guard: forking one without the other fails here.
 *
 * The local-usage and cloud-sync payloads do NOT have that property — both are
 * built by the same `assembleSyncedSessions` call, so asserting only
 * `local === synced` would compare one function's output against itself and
 * could never catch a regression in the shared resolver (both sides move
 * together). Every surface is therefore pinned to its ABSOLUTE expected mode as
 * well, which does catch a shared-resolver regression; the equality checks are
 * a secondary tie, not the thing carrying the weight.
 *
 * ── Status: these are REGRESSION LOCKS, not a fix ─────────────────────────────
 * All cases already pass on `main`. ISS-4878 was filed against the state of
 * PR #4225 as originally scoped (detection only), but that PR's review round
 * closed both read-path gaps before it merged:
 *
 *   - Branches — `resolveBranchRowBillingMode` (branch-reads.ts) re-resolves
 *     instead of copying `s.billing_mode`.
 *   - Sessions — `getSessionLedger` reads `SyncedAgentSession.billingMode`,
 *     which `assembleSyncedSessions` (sync-source.ts) populates through
 *     `resolveBillingModeForRow`.
 *   - Stored rows — `healUnknownBillingModes` (billing-mode-heal.ts) re-stamps
 *     the legacy column at boot, convergently.
 *
 * What was missing was COVERAGE: nothing pinned the Sessions ledger bucket for
 * a legacy `unknown` row, and nothing asserted Sessions and Branches cannot
 * diverge. That is what this file adds. Every case is mutation-verified against
 * the specific producer it claims to guard:
 *
 *   - `foldUsageAggregate` → raw group value  ⇒ ONLY the aggregate case fails.
 *   - `resolveBranchRowBillingMode` → raw column ⇒ both Branches cases and the
 *     cross-surface case fail.
 *   - windowed Branches read collapsed onto the all-time token rows ⇒ ONLY the
 *     all-time-vs-windowed case fails.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSessionUsageAggregateFilters } from "../src/main/agent-sync/agent-session-read-model.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { getSharedBranchUsage } from "../src/main/branch/shared-branches-api.js";
import {
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
} from "../src/main/database/branch-reads.js";
import { getSessionLedger } from "../src/main/session/session-usage-totals.js";
import { getSharedAgentSessionUsage } from "../src/main/session/shared-agent-sessions-api.js";
import { buildUsageSummary } from "../src/main/session/shared-agent-sessions-usage-summary.js";
import {
  billingLedger,
  normalizeBillingMode,
} from "../src/shared/billing-mode.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  BILLING_SEED_RESOLVED_MODE,
  type BillingSeedDb,
  seedLegacyUnknownBillingSession,
} from "./billing-mode-seed-test-helpers.js";

const LEGACY_SESSION_ID = "s-legacy-unknown";
const LEGACY_COST_USD = 1.25;

/**
 * A window that brackets the seeded fixture: the branch's `lastActivityAt`
 * (`BILLING_SEED_T1`) and the seeded `token_events` row's `created_at`
 * (`BILLING_SEED_T0`) both fall inside it, so the windowed Branches read
 * resolves a non-empty event set rather than passing vacuously on zero rows.
 */
const WINDOW_START = "2026-05-31T00:00:00.000Z";
const WINDOW_END = "2026-06-02T00:00:00.000Z";

function seedLegacySession(db: BillingSeedDb): Promise<void> {
  return seedLegacyUnknownBillingSession(db, {
    artifactId: "art-legacy-branch",
    branchName: "feature/legacy",
    costUsd: LEGACY_COST_USD,
    identityKey: "ik-legacy-branch",
    linkId: "lnk-legacy",
    sessionId: LEGACY_SESSION_ID,
  });
}

/**
 * Cost of a SECOND `token_usage` row for the same legacy session that has NO
 * matching `token_events` row. It is what makes the two Branches producers
 * DISTINGUISHABLE: the all-time (token-aggregate) read sees it, the windowed
 * (per-event) read cannot. Without it both reads would return the same number
 * and the windowed case could pass while silently running the all-time path.
 */
const TOKEN_ONLY_COST_USD = 0.75;

/** Insert the token-aggregate-only row described by `TOKEN_ONLY_COST_USD`. */
function seedTokenOnlyUsageRow(db: BillingSeedDb): Promise<unknown> {
  return db.run(
    `INSERT INTO token_usage
       (session_id, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_usd_estimated)
     VALUES ($1, 'gpt-4o-mini', 40, 20, 0, 0, $2)`,
    LEGACY_SESSION_ID,
    TOKEN_ONLY_COST_USD
  );
}

test("ISS-4878: getSessionLedger buckets a never-re-imported `unknown` row as subscription", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4878-ledger-"));
  const db = await openTestDb(dir);
  try {
    // Let the fire-and-forget boot-maintenance chain finish BEFORE seeding.
    // `healUnknownBillingModes` (sqlite.ts) re-stamps exactly the row this
    // fixture creates, so seeding into an unsettled boot races the heal: it
    // would rewrite the stored column to the resolved mode, and the read-path
    // assertions would then pass VACUOUSLY off an already-correct column
    // instead of proving re-resolution from a stored `unknown`.
    await db.whenBootMaintenanceSettled();
    await seedLegacySession(db);

    // Precondition: the STORED column is still the legacy value. The read path
    // must correct it without anything having re-written the row.
    const [stored] = await db.prisma.client.$queryRawUnsafe<
      { billing_mode: string | null }[]
    >("SELECT billing_mode FROM sessions WHERE id = $1", LEGACY_SESSION_ID);
    assert.equal(stored.billing_mode, "unknown");

    const loaded = await db.syncSource.loadUsageSessions([LEGACY_SESSION_ID]);
    assert.equal(loaded.length, 1);

    assert.equal(
      loaded[0].billingMode,
      BILLING_SEED_RESOLVED_MODE,
      "the Sessions path must re-resolve, not copy the raw column"
    );
    assert.equal(getSessionLedger(loaded[0]), "subscription");

    // The fold the usage cards actually render: the spend lands in the
    // subscription bucket, and NOTHING lands in the unclassified one.
    const summary = buildUsageSummary(loaded);
    assert.equal(summary.subscriptionEstimatedCost, LEGACY_COST_USD);
    assert.equal(
      summary.apiEstimatedCost,
      0,
      "subscription-covered spend must not fall into the API/unclassified ledger"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4878: branch usage buckets the same never-re-imported row as subscription", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4878-branch-"));
  const db = await openTestDb(dir);
  try {
    // Let the fire-and-forget boot-maintenance chain finish BEFORE seeding.
    // `healUnknownBillingModes` (sqlite.ts) re-stamps exactly the row this
    // fixture creates, so seeding into an unsettled boot races the heal: it
    // would rewrite the stored column to the resolved mode, and the read-path
    // assertions would then pass VACUOUSLY off an already-correct column
    // instead of proving re-resolution from a stored `unknown`.
    await db.whenBootMaintenanceSettled();
    await seedLegacySession(db);

    const usageRows = await readBranchUsageTokenRows(db.prisma);
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0].billingMode, BILLING_SEED_RESOLVED_MODE);
    assert.equal(
      billingLedger(normalizeBillingMode(usageRows[0].billingMode)),
      "subscription",
      "the Branches usage aggregate must re-resolve the legacy column"
    );

    const eventRows = await readBranchUsageEventRows(db.prisma);
    assert.equal(eventRows.length, 1);
    assert.equal(
      billingLedger(normalizeBillingMode(eventRows[0].billingMode)),
      "subscription",
      "the Branches per-event producer must agree with the aggregate"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4878: Sessions, Branches, and the cloud payload agree on the same session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4878-cross-"));
  const db = await openTestDb(dir);
  try {
    // Let the fire-and-forget boot-maintenance chain finish BEFORE seeding.
    // `healUnknownBillingModes` (sqlite.ts) re-stamps exactly the row this
    // fixture creates, so seeding into an unsettled boot races the heal: it
    // would rewrite the stored column to the resolved mode, and the read-path
    // assertions would then pass VACUOUSLY off an already-correct column
    // instead of proving re-resolution from a stored `unknown`.
    await db.whenBootMaintenanceSettled();
    await seedLegacySession(db);

    // The LOCAL read the usage cards fold over…
    const [local] = await db.syncSource.loadUsageSessions([LEGACY_SESSION_ID]);
    // …and the CLOUD payload the metadata sync lane uploads for the same row.
    const [synced] = await db.syncSource.loadSyncedSessions(
      [LEGACY_SESSION_ID],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );
    // …and the BRANCHES producer, which resolves at its OWN call site.
    const [branchRow] = await readBranchUsageTokenRows(db.prisma);

    // Absolute expectations first: these hold each surface to the resolved mode
    // independently, so a regression in the resolver SHARED by the local and
    // cloud projections fails here rather than moving both sides together.
    assert.equal(local.billingMode, BILLING_SEED_RESOLVED_MODE);
    assert.equal(synced.billingMode, BILLING_SEED_RESOLVED_MODE);
    assert.equal(branchRow.billingMode, BILLING_SEED_RESOLVED_MODE);

    // The load-bearing cross-surface guard: Sessions and Branches derive the
    // mode at SEPARATE call sites, so forking one without the other fails here.
    const localLedger = billingLedger(normalizeBillingMode(local.billingMode));
    assert.equal(localLedger, "subscription");
    assert.equal(
      billingLedger(normalizeBillingMode(branchRow.billingMode)),
      localLedger,
      "Branches must bucket the same session identically to Sessions"
    );

    // Secondary tie: local and cloud are built by the same
    // `assembleSyncedSessions` call, so this pins that they stay one derivation
    // rather than independently verifying them (see the header note).
    assert.equal(local.billingMode, synced.billingMode);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4878: the DEFAULT Sessions usage request folds the legacy row into subscription through the O(grouped) aggregate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4878-agg-"));
  const db = await openTestDb(dir);
  try {
    // See the seeding note on the first case: settle boot maintenance first so
    // `healUnknownBillingModes` cannot re-stamp the row out from under us.
    await db.whenBootMaintenanceSettled();
    await seedLegacySession(db);

    const source: AgentSessionSyncSource = db.syncSource;
    const { aggregateUsage } = source;
    assert.ok(
      typeof aggregateUsage === "function",
      "the SQLite sync source must expose aggregateUsage"
    );

    // Instrumented so the assertions below cannot pass off the `loadUsageSessions`
    // fallback (already covered by the first case) while the aggregate branch —
    // the one an ordinary Sessions usage request actually takes — silently rots.
    let aggregateCalls = 0;
    const instrumented: AgentSessionSyncSource = {
      ...source,
      aggregateUsage: (filters: AgentSessionUsageAggregateFilters) => {
        aggregateCalls += 1;
        return aggregateUsage(filters);
      },
    };

    const summary = await getSharedAgentSessionUsage(instrumented, {});

    assert.equal(
      aggregateCalls,
      1,
      "an unfiltered usage request must take the O(grouped) aggregate path"
    );
    assert.equal(summary.totalSessions, 1);
    // `aggregateSqliteUsage` GROUPs BY the RAW `s.billing_mode`, so this holds
    // only because `foldUsageAggregate` re-resolves per group. Reverting that to
    // the raw group value drops the spend into the unclassified bucket below.
    assert.equal(summary.subscriptionEstimatedCost, LEGACY_COST_USD);
    assert.equal(
      summary.apiEstimatedCost,
      0,
      "subscription-covered spend must not fall into the API/unclassified ledger"
    );
    assert.equal(summary.totalEstimatedCost, LEGACY_COST_USD);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4878: getSharedBranchUsage buckets the legacy row as subscription on BOTH the all-time token path and the windowed event path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4878-branch-usage-"));
  const db = await openTestDb(dir);
  try {
    // See the seeding note on the first case: settle boot maintenance first so
    // `healUnknownBillingModes` cannot re-stamp the row out from under us.
    await db.whenBootMaintenanceSettled();
    await seedLegacySession(db);
    await seedTokenOnlyUsageRow(db);

    // ALL-TIME (no window) → per-(session, model) `token_usage` aggregate, so
    // both priced rows count.
    const allTime = await getSharedBranchUsage(db, {});
    assert.equal(allTime.totalBranches, 1);
    assert.equal(
      allTime.subscriptionEstimatedCost,
      LEGACY_COST_USD + TOKEN_ONLY_COST_USD
    );
    assert.equal(
      allTime.apiEstimatedCost,
      0,
      "the all-time Branches rollup must not bucket subscription spend as API"
    );

    // WINDOW ACTIVE → per-event `token_events` rows, so only the event-backed
    // row counts. Same branch, same session, a genuinely different producer.
    const windowed = await getSharedBranchUsage(db, {
      endDate: WINDOW_END,
      startDate: WINDOW_START,
    });
    assert.equal(windowed.totalBranches, 1);
    assert.equal(windowed.subscriptionEstimatedCost, LEGACY_COST_USD);
    assert.equal(
      windowed.apiEstimatedCost,
      0,
      "the windowed Branches rollup must not bucket subscription spend as API"
    );

    // The token-only row is visible to the all-time read and invisible to the
    // windowed one, which is what proves the second call really resolved through
    // the EVENT producer instead of quietly re-running the all-time path.
    assert.notEqual(
      windowed.subscriptionEstimatedCost,
      allTime.subscriptionEstimatedCost,
      "the windowed read must resolve through the per-event producer"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
