/**
 * @file component-tombstone-cursor-text-order.test.ts
 * @description The durable cursor floor is read in the SAME representation the sync
 * lane compares, so a floor that passes {@link warnOnUnclearedFloor} is one the lane
 * will genuinely sort behind.
 *
 * ISS-10027 established that invariant when the lane paged on stored BYTES, and read
 * the floor raw for it. ISS-11327 moved the lane onto a RANKING KEY —
 * `componentCursorCanonicalRankSql(last_seen_at)`, `last_seen_at` read as an instant — so the
 * same invariant now requires the floor to be RANKED. The invariant did not change;
 * the representation it names did, and this suite moved with it.
 *
 * WHAT THAT RETIRES, deliberately rather than by weakening an assertion. ISS-10027
 * pinned the whole-second `…:00Z` floor as UNCLEARABLE — `Z` (0x5A) sorts after `.`
 * (0x2E), so it outranked every `…:00.NNNZ` key derivable from it and the tombstone
 * was stranded. Ranked, that floor and that key are one instant a millisecond apart
 * and the key clears it, so the first case below now asserts the tombstone RE-ENTERS
 * the lane and no warning fires. That is the defect being fixed, not coverage being
 * dropped: the warning keeps its own case, on a floor that still genuinely cannot be
 * cleared, and the corrupt-cursor report it used to cover is now made by the reader
 * that holds the raw value.
 *
 * This lives beside `component-tombstone-keyset-cursor.test.ts` rather than in it:
 * that file is already ~700 lines and owns a different contract (that a tombstone
 * RE-ENTERS the lane). This one owns the representation contract at the boundary.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { componentCursorRank } from "../src/main/database/component-cursor-rank.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { reserveComponentOrderingKey } from "../src/main/packs/component-tombstone.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/**
 * A cursor stored WITHOUT the millisecond field. Shape-legal ISO-8601 that
 * `Date.parse` reads exactly, and 20 characters rather than the canonical 24 — so on
 * BYTE order it out-sorts every canonical key derived from it, and on the lane's
 * ranking order it does not.
 */
const WHOLE_SECOND_CURSOR = "2030-01-01T00:00:00Z";

/**
 * A cursor carrying no readable instant at all. It ranks to the keyset floor, so it
 * contributes no floor to the derivation and is REPORTED as corrupt instead.
 */
const UNREADABLE_CURSOR = "2030-01-01 00:00:00";

/**
 * A cursor at the far end of the representable range. Its `+1ms` key renders as the
 * EXTENDED form `+010000-…`, and `+` (0x2B) sorts below every 4-digit year, so this
 * is the floor the minted key still genuinely cannot clear.
 */
const END_OF_RANGE_CURSOR = "9999-12-31T23:59:59.999Z";
const CURSOR_COMPUTE_TARGET = "compute-target-iss10027-text-order";
const SCAN_INSTANT = "2026-01-01T00:00:00.000Z";

const INSERT_SYNC_STATE_SQL = `INSERT INTO sync_state
     (source_key, observed_top_updated_at, observed_ids_at_top_updated_at, updated_at)
   VALUES ($1, $2, '[]', $3)`;

/** Capture `gatewayLog.warn` for one call, restoring the exact previous method. */
async function withCapturedWarnings<T>(
  run: () => Promise<T>
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = gatewayLog.warn.bind(gatewayLog);
  gatewayLog.warn = (tag: string, message: string) => {
    warnings.push(`${tag}: ${message}`);
  };
  try {
    return { result: await run(), warnings };
  } finally {
    gatewayLog.warn = original;
  }
}

async function seedLaneCursor(
  prisma: DesktopPrisma,
  position: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      INSERT_SYNC_STATE_SQL,
      buildAgentComponentSyncSourceKey(CURSOR_COMPUTE_TARGET),
      position,
      SCAN_INSTANT
    )
  );
}

test("ISS-11327: a whole-second durable cursor is now CLEARED, because the lane ranks", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedLaneCursor(prisma, WHOLE_SECOND_CURSOR);

    const { result: key, warnings } = await withCapturedWarnings(() =>
      prisma.write((client) =>
        reserveComponentOrderingKey(client, SCAN_INSTANT)
      )
    );

    // The cursor was PARSED as a floor: the key is derived from the cursor's instant,
    // not from the much earlier scan instant.
    assert.equal(
      key,
      "2030-01-01T00:00:00.001Z",
      "the durable cursor's instant must floor the key even when stored non-canonically"
    );

    // The fixture premise, kept so this case cannot stop being the interesting one:
    // on BYTE order — what the lane compared before ISS-11327 — the key still loses.
    assert.ok(
      key < WHOLE_SECOND_CURSOR,
      "fixture must keep the minted key below the RAW cursor in byte order"
    );

    // And the contract that replaced it: against the RANKED floor the lane actually
    // compares, the key sorts above, so the tombstone re-enters the lane.
    assert.ok(
      key > componentCursorRank(WHOLE_SECOND_CURSOR),
      "the minted key must clear the floor in the order the lane now uses"
    );
    assert.deepEqual(
      warnings,
      [],
      `a floor the lane will sort behind must not warn; got ${JSON.stringify(warnings)}`
    );
  } finally {
    await close();
  }
});

test("ISS-11327: a durable cursor with no readable instant is reported as corrupt", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedLaneCursor(prisma, UNREADABLE_CURSOR);

    const { result: key, warnings } = await withCapturedWarnings(() =>
      prisma.write((client) =>
        reserveComponentOrderingKey(client, SCAN_INSTANT)
      )
    );

    // It contributes NO floor, so the key falls back to the scan instant + 1ms.
    assert.equal(key, "2026-01-01T00:00:00.001Z");
    assert.ok(
      warnings.some(
        (line) =>
          line.includes("no readable instant") &&
          line.includes(UNREADABLE_CURSOR)
      ),
      `an unrankable cursor must be reported with the RAW stored value; got ${JSON.stringify(warnings)}`
    );
  } finally {
    await close();
  }
});

test("ISS-11327: a floor the minted key genuinely cannot clear is still reported", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedLaneCursor(prisma, END_OF_RANGE_CURSOR);

    const { result: key, warnings } = await withCapturedWarnings(() =>
      prisma.write((client) =>
        reserveComponentOrderingKey(client, SCAN_INSTANT)
      )
    );

    // Past year 9999 `toISOString` switches to the extended form, which sorts below
    // every 4-digit year — so the tombstone genuinely does not re-enter the lane.
    assert.equal(key, "+010000-01-01T00:00:00.000Z");
    assert.ok(
      key < componentCursorRank(END_OF_RANGE_CURSOR),
      "fixture must keep the minted key below the RANKED floor, or nothing here is being tested"
    );
    assert.ok(
      warnings.some(
        (line) =>
          line.includes("does not sort above") &&
          line.includes("durable lane cursor")
      ),
      `the uncleared floor must be reported; got ${JSON.stringify(warnings)}`
    );
  } finally {
    await close();
  }
});

test("a canonical durable cursor the key clears is not reported", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const canonicalCursor = "2030-01-01T00:00:00.000Z";
    await seedLaneCursor(prisma, canonicalCursor);

    const { result: key, warnings } = await withCapturedWarnings(() =>
      prisma.write((client) =>
        reserveComponentOrderingKey(client, SCAN_INSTANT)
      )
    );

    assert.equal(key, "2030-01-01T00:00:00.001Z");
    assert.ok(
      key > canonicalCursor,
      "a canonical cursor must be cleared in TEXT order"
    );
    assert.deepEqual(
      warnings,
      [],
      `a cleared floor must not warn; got ${JSON.stringify(warnings)}`
    );
  } finally {
    await close();
  }
});
