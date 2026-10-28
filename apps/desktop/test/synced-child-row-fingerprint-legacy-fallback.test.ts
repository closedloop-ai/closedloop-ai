/**
 * @file synced-child-row-fingerprint-legacy-fallback.test.ts
 * @description ISS-8757 (review: davetho): the `hasRowDigest === false` branch
 * must see an EQUAL-LENGTH substitution in a synced event column.
 *
 * ISS-8757 puts the incremental import's events phase on this fold
 * (`computeSyncedEventRowFingerprint`), so the branch a build without `sha3()`
 * lands on is no longer confined to the DATA_REVISION rebuild. The pre-ISS-8757
 * fallback folded `SUM(LENGTH(row))`, `COUNT(*)` and the FIRST character of the
 * row concatenation only, so an equal-length rewrite past character one folded
 * identical — which would have left `eventsChanged` false, the watermark
 * unmoved, and the corrected row stranded under the sync cursor: the exact gap
 * this ticket exists to close, reinstated on the degraded build.
 *
 * The substitution below is chosen so EVERY term of that old fold is preserved:
 * the row count is untouched, the replacement is byte-for-byte the same LENGTH,
 * and it lands on `agent_id` — not the first column — so the sampled first
 * character of the concatenation is unchanged too. A fold that still reports
 * "unchanged" here is blind in precisely the way the review names.
 *
 * `agent_id` deliberately, not `data`: it is the column FEA-2718 leaves ON the
 * sync wire (`agentExternalId`), and the ISS-4592 delegation re-point is the
 * reachable production case that moves it while the row id and the event count
 * both stay put.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import {
  computeSyncedChildRowFingerprint,
  computeSyncedEventRowFingerprint,
} from "../src/main/database/synced-child-row-fingerprint.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

/** The probe's answer on a libSQL build without `sha3()` — the branch under test. */
const FORCED_FALLBACK = false;
const SESSION_ID = "legacy-fallback-equal-length";

test("ISS-8757: the forced fallback sees an equal-length synced-column substitution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-fallback-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(
      makePopulatedSession({
        sessionId: SESSION_ID,
        toolUses: [
          {
            name: "Read",
            timestamp: "2026-06-07T10:01:00.000Z",
            id: "toolu_legacy_fallback",
            input: { file_path: "/workspace/test/example.ts" },
          },
        ],
      }),
      Harness.Claude
    );
    const rows = await db.prisma.client.$queryRawUnsafe<
      { id: string; agent_id: string }[]
    >(
      "SELECT id, agent_id FROM events WHERE session_id = $1 ORDER BY id",
      SESSION_ID
    );
    assert.ok(rows.length > 0, "precondition: the import wrote event rows");
    const target = rows[0];
    assert.ok(target, "precondition: an event row was read back");

    const eventsBefore = await computeSyncedEventRowFingerprint(
      db.prisma.client,
      SESSION_ID,
      FORCED_FALLBACK
    );
    const sessionBefore = await computeSyncedChildRowFingerprint(
      db.prisma.client,
      SESSION_ID,
      FORCED_FALLBACK
    );
    assert.notEqual(
      eventsBefore,
      "",
      "precondition: the fallback produced a fingerprint, not an empty read"
    );

    // Same width, different bytes, and NOT the projection's first column — so
    // the pre-ISS-8757 fold's three terms (summed length, row count, sampled
    // first character) are all preserved and it cannot see this.
    const substituted = `${target.agent_id.slice(0, -4)}${flipTail(target.agent_id)}`;
    assert.equal(
      substituted.length,
      target.agent_id.length,
      "the substitution must be EQUAL-LENGTH or it proves nothing"
    );
    assert.notEqual(
      substituted,
      target.agent_id,
      "the substitution must actually differ"
    );
    await db.run(
      "UPDATE events SET agent_id = $1 WHERE id = $2",
      substituted,
      target.id
    );
    const rowsAfter = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM events WHERE session_id = $1",
      SESSION_ID
    );
    assert.equal(
      Number(rowsAfter[0]?.n),
      rows.length,
      "the substitution must be equal-CARDINALITY too"
    );

    assert.notEqual(
      await computeSyncedEventRowFingerprint(
        db.prisma.client,
        SESSION_ID,
        FORCED_FALLBACK
      ),
      eventsBefore,
      "the events fallback must move on an equal-length synced-column rewrite"
    );
    assert.notEqual(
      await computeSyncedChildRowFingerprint(
        db.prisma.client,
        SESSION_ID,
        FORCED_FALLBACK
      ),
      sessionBefore,
      "the whole-session fallback folds the same projection and must move too"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8757: the forced fallback is stable when nothing changed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-fallback-stable-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(
      makePopulatedSession({ sessionId: SESSION_ID }),
      Harness.Claude
    );
    const first = await computeSyncedEventRowFingerprint(
      db.prisma.client,
      SESSION_ID,
      FORCED_FALLBACK
    );
    assert.notEqual(first, "");
    // A fold that reported "changed" on every read would satisfy the assertion
    // above while re-syncing the whole corpus forever.
    assert.equal(
      await computeSyncedEventRowFingerprint(
        db.prisma.client,
        SESSION_ID,
        FORCED_FALLBACK
      ),
      first,
      "an unchanged table must fold to the identical value"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Four replacement characters, each guaranteed different from the byte it replaces. */
function flipTail(value: string): string {
  return value
    .slice(-4)
    .split("")
    .map((character) => (character === "z" ? "q" : "z"))
    .join("");
}
