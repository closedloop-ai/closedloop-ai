/**
 * @file session-status-facet-malformed-anchor-parity.test.ts
 * @description ISS-6795: the activity ANCHOR of a row whose `started_at` is
 * MALFORMED — the one input on which the three readings of "when was this row
 * last active" can disagree.
 *
 * There are three, and a list read consults all three for a single row:
 *
 *   - the STORED `sessions.last_activity_at` column, which the SQL twin
 *     (`buildUsageStatusPredicate`, via the FEA-4142 count read) compares
 *     against the cutoff and which the cursor page pre-selects on;
 *   - the HYDRATED `SyncedAgentSession.lastActivityAt`, re-derived from the
 *     event rows by `assembleSyncedSessions`;
 *   - the SERVED instant `mapListItem` puts on the wire
 *     (`servedSessionActivityAt`), which is what the row's badge folds.
 *
 * The write side already floors a malformed `started_at` at epoch
 * (`SESSION_STARTED_AT_FLOOR_SQL`) before taking the event max, so the column is
 * always a real instant. The hydrated derivation did not: it seeded its running
 * max with the raw string, whose NaN epoch loses no comparison, and so discarded
 * every event. That made the fold answer "epoch" where the column answered "the
 * latest event", which put the row's BADGE at odds with the count beside it —
 * and, while the facet still folded the served instant, dropped it out of the
 * cursor page's pre-selection and post-hydration recheck alike.
 *
 * Both halves are EXECUTED here — the store's own fold against a real SQLite
 * database, the JS fold by hydrating that same row — because a test that asserted
 * one derived value alone would not notice the two paths parting.
 *
 * The parity pinned here is for a reading NEITHER side can use. A date-SHAPED
 * but invalid one (`2026-13-45T…`) is a different case and is deliberately NOT
 * claimed: the store compares it byte-wise and reads it as recent, the display
 * side floors it at epoch and reads it Stale, and no expression available to the
 * SQL twin reproduces `Date.parse`. Such a row badged Stale while the count read
 * called it Active before ISS-6795 as well; what this ticket changes is that the
 * FACET now sides with the badge instead of adding a third answer.
 *
 * THE STATUS FACET IS NO LONGER A READER OF THE ANCHOR, so it is no longer what
 * this file asserts through. ISS-10629 retired the STALE facet and ISS-10741
 * dropped ACTIVE's staleness subtraction, after which the ACTIVE/STALE loop that
 * closed this file answered the same way on any anchor at all — reseeding the
 * event instant with a stale one left it green (tamsinb, PR #7677). It is
 * deleted rather than repaired: the contract it stated is retired, and an
 * assertion that cannot fail is worse than none.
 *
 * The BADGE is the reader that remains, and the assertion at the foot of this
 * test is the one that still discriminates — a stale-seeded anchor reddens it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { test } from "vitest";
import type { SessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { SESSION_EPOCH_TIMESTAMP } from "../src/main/agent-sync/session-date-window.js";
import { recomputeSessionLastActivityAt } from "../src/main/database/write-core.js";
import { servedSessionActivityAt } from "../src/main/session/session-activity-anchor.js";
import { projectDisplayedSharedStatus } from "../src/main/session/shared-agent-session-status.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { recentActivityAt } from "./shared-agent-sessions-test-helpers.js";

const SESSION_ID = "malformed-started-at";
/** Not a date in any shape: the date-prefix GLOB rejects it and `Date` NaNs on it. */
const MALFORMED_STARTED_AT = "not-a-date";
/**
 * Date-SHAPED but not a date: `Date` cannot parse it, and it sorts below every
 * real instant, so the store's `MAX` discards it as well.
 */
const UNPARSEABLE_EVENT_AT = "0000-00-00T00:00:00Z";

function emptyAttributionCache(): SessionAttributionResolverCache {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

test("ISS-6795: a malformed `started_at` resolves to the same activity instant on the stored column and the hydrated fold", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6795-anchor-parity-"));
  const db = await openTestDb(dir);
  const eventAt = recentActivityAt();
  try {
    await db.run(
      `INSERT INTO sessions
         (id, status, started_at, updated_at, ended_at, harness, billing_mode, awaiting_input_since, last_activity_at)
       VALUES ($1, $2, $3, $4, NULL, 'claude', 'api', NULL, $5)`,
      SESSION_ID,
      SESSION_STATUS.ACTIVE,
      MALFORMED_STARTED_AT,
      eventAt,
      // The migration-0005 NOT NULL default. The real recompute below overwrites
      // it, so nothing here hand-writes the value the SQL twin then reads.
      SESSION_EPOCH_TIMESTAMP
    );
    // Two events, the earlier one UNPARSEABLE. `events.created_at` holds raw
    // harness transcript text and is the one timestamp column the FEA-3743 heal
    // never repairs, so an unusable reading is reachable here in a way it is not
    // on the healed columns — and the derivation must skip it rather than let it
    // become a running max nothing can beat. The store's own fold discards it
    // too, so the column still holds the recent event.
    for (const [suffix, createdAt] of [
      ["unparseable", UNPARSEABLE_EVENT_AT],
      ["recent", eventAt],
    ] as const) {
      await db.run(
        "INSERT INTO events (id, session_id, event_type, created_at) VALUES ($1, $2, 'tool_use', $3)",
        `${SESSION_ID}-${suffix}`,
        SESSION_ID,
        createdAt
      );
    }

    // The store's OWN fold decides the column — `recomputeSessionLastActivityAt`
    // is what every ingest transaction runs — so a change to
    // `SESSION_LAST_ACTIVITY_AT_VALUE_SQL` moves this side of the comparison here
    // exactly as it would in production, instead of being pinned to a literal
    // this test happened to agree with on the day it was written.
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        recomputeSessionLastActivityAt(tx, SESSION_ID)
      )
    );
    const [storedRow] = await db.prisma.client.$queryRawUnsafe<
      { last_activity_at: string }[]
    >("SELECT last_activity_at FROM sessions WHERE id = $1", SESSION_ID);
    assert.equal(storedRow?.last_activity_at, eventAt);

    const [hydrated] = (await db.syncSource.loadSyncedSessions(
      [SESSION_ID],
      emptyAttributionCache()
    )) as SyncedAgentSession[];
    assert.ok(hydrated);
    // The ISS-5443 invariant: the re-derived activity instant IS the stored
    // column, so the served instant the badge folds is a real one and not epoch.
    assert.equal(hydrated.lastActivityAt, eventAt);
    assert.equal(
      servedSessionActivityAt(hydrated).toISOString(),
      new Date(eventAt).toISOString()
    );

    // The consequence the derivation above exists for: the badge reads the
    // SERVED instant, so recovering the real event instant is what keeps this
    // row from displaying Stale. Seed the event with a stale instant and this is
    // the assertion that reddens.
    assert.equal(
      projectDisplayedSharedStatus(hydrated),
      DISPLAYED_SESSION_STATUS.ACTIVE
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
