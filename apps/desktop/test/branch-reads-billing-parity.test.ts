/**
 * @file branch-reads-billing-parity.test.ts
 * @description ISS-4869 review follow-up. The Branches usage producers must
 * resolve a session's billing mode the SAME way every Sessions path does,
 * instead of copying the raw `sessions.billing_mode` column.
 *
 * Before this fix the Branches reads passed the stored column straight through,
 * so once the Keychain detector started resolving historical `unknown` rows to
 * a real mode, the identical spend was bucketed one way in Sessions and another
 * in Branches — the same dollars reading as subscription-covered on one screen
 * and unclassified on the other.
 *
 * `copilot` is the harness under test on purpose: its detection is a pure
 * constant (`detectCopilotBillingMode` always returns `copilot_seat`), so the
 * assertion is deterministic and needs no env, filesystem, or Keychain state.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
} from "../src/main/database/branch-reads.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  BILLING_SEED_RESOLVED_MODE,
  BILLING_SEED_T0,
  seedLegacyUnknownBillingSession,
} from "./billing-mode-seed-test-helpers.js";

const T0 = BILLING_SEED_T0;

test("ISS-4869: branch usage reads re-resolve a legacy `unknown` billing mode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "branch-billing-parity-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "unknown",
    emit: () => undefined,
    now: () => T0,
  });
  try {
    // Settle the fire-and-forget boot-maintenance chain BEFORE seeding:
    // `healUnknownBillingModes` re-stamps exactly this row shape, so racing it
    // would leave the assertions below reading an already-corrected column
    // instead of proving the branch reads re-resolve a stored `unknown`.
    await db.whenBootMaintenanceSettled();
    // A historical row persisted BEFORE the detector could classify it: the
    // column still says 'unknown', but the harness is knowable. Seeded through
    // the shared helper so this suite and the ISS-4878 read-path parity suite
    // can never drift into asserting against subtly different rows.
    await seedLegacyUnknownBillingSession(db, {
      artifactId: "art-b",
      branchName: "feature/x",
      identityKey: "ik-branch",
      linkId: "lnk-1",
      sessionId: "bs-legacy",
    });

    // The aggregate producer: 'unknown' must NOT survive to the consumer.
    const usage = await readBranchUsageTokenRows(db.prisma);
    assert.equal(usage.length, 1);
    assert.equal(
      usage[0].billingMode,
      BILLING_SEED_RESOLVED_MODE,
      "branch usage row must re-resolve, not copy the raw column"
    );

    // The per-event producer reads the same column and must agree with it.
    const events = await readBranchUsageEventRows(db.prisma);
    assert.equal(events.length, 1);
    assert.equal(
      events[0].billingMode,
      BILLING_SEED_RESOLVED_MODE,
      "branch event row must resolve identically to the aggregate row"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
