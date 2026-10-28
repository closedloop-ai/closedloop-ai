/**
 * @file data-revision-rebuild-metadata-refresh.test.ts
 * @description FEA-1785 TEST 15b, extracted from the sibling
 * `data-revision-rebuild.test.ts` (ISS-8741) the same way ISS-5071 extracted
 * `data-revision-rollup-stamp-gate.test.ts`: that file is on the
 * `noExcessiveLinesPerFile` grandfather list, which is SHRINK-ONLY, and
 * repairing this test's fixture grew it.
 *
 * The fixture needed repairing because ISS-8741 gates the rebuild on the
 * canonical derived-record schema. The `plans` entries here used to be
 * `{ title, status }` — keys `NormalizedPlan` does not have and no parser can
 * emit, which only survived because the sibling file sits on
 * `tsconfig.tests.json`'s exclude list. Under the gate an unemittable candidate
 * is refused, so the metadata refresh this test is actually about never ran.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

describe("FEA-1785 rebuild metadata refresh (TEST 15b)", () => {
  test("15b: Metadata refresh — rebuild replaces stale metadata with current parse output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea1785-t15-"));
    const db = await openTestDb(dir);
    try {
      const sid = "meta-refresh";
      // Import a session with initial metadata
      const session = makeSession({
        sessionId: sid,
        plans: [
          {
            source: "ExitPlanMode",
            content: "old plan",
            timestamp: "2026-06-07T10:00:10.000Z",
          },
        ],
        userMessages: 5,
      });
      await db.importer.importSession(session, "claude");

      const before = await db.prisma.client.$queryRawUnsafe<
        { metadata: string }[]
      >("SELECT metadata FROM sessions WHERE id = $1", sid);
      const metaBefore = JSON.parse(before[0].metadata);
      assert.equal(metaBefore.userMessages, 5);
      assert.equal(metaBefore.plans.length, 1);

      // Downgrade revision to make it stale
      await db.run(
        "UPDATE sessions SET data_revision = 0, status = 'inactive' WHERE id = $1",
        sid
      );

      // Rebuild with updated metadata
      const updatedSession = makeSession({
        sessionId: sid,
        plans: [
          {
            source: "ExitPlanMode",
            content: "plan 1",
            timestamp: "2026-06-07T10:00:20.000Z",
          },
          {
            source: "ExitPlanMode",
            content: "plan 2",
            timestamp: "2026-06-07T10:00:30.000Z",
          },
        ],
        userMessages: 12,
      });
      const summary = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: [`/fake/${sid}.jsonl`],
            sessionIdForSource: () => sid,
            parse: () => Promise.resolve([updatedSession]),
          }),
        ],
        db,
      });
      assert.equal(summary.rebuilt, 1);

      const after = await db.prisma.client.$queryRawUnsafe<
        { metadata: string }[]
      >("SELECT metadata FROM sessions WHERE id = $1", sid);
      const metaAfter = JSON.parse(after[0].metadata);
      assert.equal(
        metaAfter.userMessages,
        12,
        "metadata reflects current parse"
      );
      assert.equal(
        metaAfter.plans.length,
        2,
        "plans updated from current parse"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
