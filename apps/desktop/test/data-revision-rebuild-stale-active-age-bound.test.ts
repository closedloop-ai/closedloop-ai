/**
 * @file data-revision-rebuild-stale-active-age-bound.test.ts
 * @description ISS-8601 — a wedged non-terminal row reaches the rebuild and is
 * actually STAMPED, end to end.
 *
 * A NEW file rather than cases in `data-revision-rebuild.test.ts`, which is in
 * the shrink-only file-size grandfather list.
 *
 * The point of driving the whole pipeline here is that a selection-only check
 * cannot see the failure this ticket kept re-introducing: three separate
 * in-transaction guards re-read the row and refuse it, so "the row was selected"
 * and "the row was rebuilt" are different claims, and only the second one is the
 * feature. Every assertion below is on the stamp or on a counter, never on the
 * selection alone.
 *
 * The clock is `openTestDb`'s frozen `2026-06-07T12:00:00.000Z` throughout, and
 * fixture timestamps are expressed relative to THAT instant, not to `Date.now()`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { SESSION_TIMESTAMP_EPOCH } from "../src/main/database/session-timestamp-form.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

/** The instant `openTestDb` pins its store clock to. */
const FROZEN_NOW_MS = Date.parse("2026-06-07T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function hoursBeforeFrozenNow(n: number): string {
  return new Date(FROZEN_NOW_MS - n * HOUR_MS).toISOString();
}

async function revisionOf(
  db: Awaited<ReturnType<typeof openTestDb>>,
  sessionId: string
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { data_revision: number }[]
  >("SELECT data_revision FROM sessions WHERE id = $1", sessionId);
  return rows[0].data_revision;
}

describe("ISS-8601: the age bound admits a wedged row all the way to the stamp", () => {
  test("an `active` row silent for 48h is REBUILT and stamped, not merely selected", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8601-wedged-"));
    const db = await openTestDb(dir);
    try {
      const sid = "wedged-active";
      const session = makeSession({ sessionId: sid });
      await db.importer.importSession(session, "claude");
      // Wedged by definition: non-terminal, and silent well past the bound
      // measured against the store's own clock.
      await db.run(
        "UPDATE sessions SET data_revision = $1, status = 'active', last_activity_at = $2 WHERE id = $3",
        1,
        hoursBeforeFrozenNow(48),
        sid
      );

      const summary = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: ["/fake/wedged.jsonl"],
            parse: () => Promise.resolve([session]),
            sessionIdForSource: () => sid,
          }),
        ],
        db,
      });

      assert.equal(summary.wedgedActiveAdmitted, 1, "admitted, and counted");
      assert.equal(summary.skippedActive, 0, "not skipped");
      assert.equal(
        summary.raceSkipped,
        0,
        "and NOT refused by the in-tx guard"
      );
      assert.equal(summary.rebuilt, 1);
      // The assertion that matters: selection alone would satisfy every counter
      // above except this one.
      assert.equal(
        await revisionOf(db, sid),
        effectiveDataRevision(),
        "the wedged row leaves the stale population"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an `active` row that is still live is skipped and left stale", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8601-live-"));
    const db = await openTestDb(dir);
    try {
      const sid = "live-active";
      const session = makeSession({ sessionId: sid });
      await db.importer.importSession(session, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1, status = 'active', last_activity_at = $2 WHERE id = $3",
        1,
        hoursBeforeFrozenNow(1),
        sid
      );

      const summary = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: ["/fake/live.jsonl"],
            parse: () => Promise.resolve([session]),
            sessionIdForSource: () => sid,
          }),
        ],
        db,
      });

      assert.equal(summary.skippedActive, 1, "a live capture is still refused");
      assert.equal(summary.wedgedActiveAdmitted, 0);
      assert.equal(summary.rebuilt, 0);
      assert.equal(
        await revisionOf(db, sid),
        1,
        "left stale for ordinary import"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a row that REVIVES between selection and the transaction is refused", async () => {
    // The second line of defence. The row is wedged at selection, so the bound
    // admits it, and then goes live before the rebuild transaction opens. The
    // in-tx guard re-reads `last_activity_at` and refuses it — which is what
    // makes `activeRace` mean "came back to life" rather than "was non-terminal".
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8601-revive-"));
    const db = await openTestDb(dir);
    try {
      const sid = "revived";
      const session = makeSession({ sessionId: sid });
      await db.importer.importSession(session, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1, status = 'active', last_activity_at = $2 WHERE id = $3",
        1,
        hoursBeforeFrozenNow(48),
        sid
      );

      const summary = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: ["/fake/revived.jsonl"],
            sessionIdForSource: () => sid,
            parse: async () => {
              // The revival lands after the snapshot, before the tx.
              await db.run(
                "UPDATE sessions SET last_activity_at = $1 WHERE id = $2",
                new Date(FROZEN_NOW_MS).toISOString(),
                sid
              );
              return [session];
            },
          }),
        ],
        db,
      });

      assert.equal(summary.wedgedActiveAdmitted, 1, "admitted at selection");
      assert.equal(summary.raceSkipped, 1, "and refused in the transaction");
      assert.equal(summary.rebuilt, 0);
      assert.equal(await revisionOf(db, sid), 1, "never stamped");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ISS-8601: the clock is read across the db-host process boundary", () => {
  test("a `now()` that resolves a PROMISE still admits a wedged row", async () => {
    // In production `db` is the FEA-2038 forwarding proxy: every property answers
    // and every call becomes an IPC `invoke`, so `now()` is a Promise. Reading it
    // without awaiting yields `new Date(Promise)` -> Invalid Date -> NaN elapsed
    // -> "not stale" for EVERY row, and the whole feature is inert in production
    // while every in-process test stays green. This case is the only thing in the
    // suite that exercises the production shape.
    let rebuilt = 0;
    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: ["/fake/proxy.jsonl"],
          sessionIdForSource: () => "proxied",
          parse: () => Promise.resolve([makeSession({ sessionId: "proxied" })]),
        }),
      ],
      db: {
        now: () => Promise.resolve(new Date(FROZEN_NOW_MS).toISOString()),
        listStaleRevisionSessions: () =>
          Promise.resolve([
            {
              id: "proxied",
              harness: "claude",
              status: "active",
              lastActivityAt: hoursBeforeFrozenNow(48),
            },
          ]),
        rebuildSessionFromParse: () => {
          rebuilt++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(true),
      },
    });

    assert.equal(
      summary.wedgedActiveAdmitted,
      1,
      "an awaited clock classifies the row; an unawaited one calls it live"
    );
    assert.equal(rebuilt, 1, "and it reaches the rebuild");
  });

  test("a db with NO clock falls back and still fails closed on a missing anchor", async () => {
    // Every pre-existing double omits both the clock and the anchor. It must keep
    // taking the same branch it always did.
    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: ["/fake/legacy.jsonl"],
          sessionIdForSource: () => "legacy",
          parse: () => Promise.resolve([makeSession({ sessionId: "legacy" })]),
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([
            { id: "legacy", harness: "claude", status: "active" },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(true),
      },
    });

    assert.equal(summary.skippedActive, 1);
    assert.equal(summary.wedgedActiveAdmitted, 0);
  });
});

describe("ISS-8601: an admitted wedged row is never DELETED, and never sealed", () => {
  test("a refused delete is not counted, not logged, and leaves the row stale", async () => {
    // The burst-artifact path. The store refuses to delete a non-terminal row, and
    // while that refusal was a `void` return the caller counted it in `deleted`,
    // logged it as deleted, and dropped it from the pass — so the row stayed in
    // the store, unstamped, and was re-selected on every subsequent boot.
    const logs: string[] = [];
    let deleteCalls = 0;
    const summary = await runDataRevisionRebuild({
      log: (m) => logs.push(m),
      collectors: [
        fakeCollector("codex", {
          sources: ["/fake/burst.jsonl"],
          sessionIdForSource: () => "burst",
          // The burst arm is the whole point of this case: it is the only branch
          // that reaches a delete from an empty parse.
          isBurstArtifactSource: () => true,
          parse: () => Promise.resolve([]),
        }),
      ],
      db: {
        now: () => new Date(FROZEN_NOW_MS).toISOString(),
        listStaleRevisionSessions: () =>
          Promise.resolve([
            {
              id: "burst",
              harness: "codex",
              status: "active",
              lastActivityAt: hoursBeforeFrozenNow(48),
            },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => {
          deleteCalls++;
          // What the real store does for a non-terminal row: refuse, and say so.
          return Promise.resolve(false);
        },
      },
    });

    assert.equal(deleteCalls, 1, "the delete was attempted");
    assert.equal(
      summary.deleted,
      0,
      "and NOT counted, because it did not happen"
    );
    assert.equal(
      logs.filter((m) => m.includes("deleted import artifact")).length,
      0,
      "and not logged as a deletion"
    );
    // The row keeps its stale revision as the durable retry marker, so a later
    // pass re-selects it once it reaches a terminal status. What it must NOT do is
    // reach the repair tail, whose stored-invocation bridge stamps
    // `data_revision` unconditionally and would seal it at the current revision.
    assert.equal(
      summary.missingSource,
      0,
      "it is not routed to the repair tail"
    );
  });
});

describe("ISS-8601: an in-flight import is never torn down", () => {
  test("a row still carrying the epoch DEFAULT is refused, not rebuilt", async () => {
    // The seventh defect. The isolated import writes the session row in one
    // write-queue group and recomputes `last_activity_at` in a LATER one, so
    // between them (and durably for an import evicted in between) the row reads:
    // non-terminal, stale revision, anchor = the schema default. Admitting it
    // would tear the session down mid-import and stamp over the
    // DATA_REVISION_IMPORT_PENDING sentinel that exists so an interrupted import
    // re-heals instead of sealing with derived rows missing.
    let rebuilt = 0;
    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: ["/fake/inflight.jsonl"],
          sessionIdForSource: () => "inflight",
          parse: () =>
            Promise.resolve([makeSession({ sessionId: "inflight" })]),
        }),
      ],
      db: {
        now: () => new Date(FROZEN_NOW_MS).toISOString(),
        listStaleRevisionSessions: () =>
          Promise.resolve([
            {
              id: "inflight",
              harness: "claude",
              status: "active",
              lastActivityAt: SESSION_TIMESTAMP_EPOCH,
            },
          ]),
        rebuildSessionFromParse: () => {
          rebuilt++;
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(true),
      },
    });

    assert.equal(rebuilt, 0, "the in-flight row is never rebuilt");
    assert.equal(summary.wedgedActiveAdmitted, 0, "and never admitted");
    assert.equal(
      summary.skippedActive,
      1,
      "it fails closed like any unreadable anchor"
    );
  });
});

describe("ISS-8601: a wedged row is never sealed by the repair tail", () => {
  test("a wedged row that reaches the repair tail is withheld from the stamp", async () => {
    // The repair tail's stored-invocation bridge stamps `data_revision`
    // unconditionally, and a stamped row is never selected again. A wedged row can
    // reach that tail by several routes — a refused delete, a THROWN delete, an
    // unmatched source — so the withholding is enforced on the admitted set at the
    // tail itself rather than at each route.
    const stampedIds: string[] = [];
    const summary = await runDataRevisionRebuild({
      useStoredComponentInvocationRebuild: true,
      collectors: [
        // NO sources: the pending id is never matched by the source walk, so it
        // defers to the repair tail as `missingSource` — which is exactly the
        // cohort `runRepairTail` hands to the stamping bridge.
        fakeCollector("claude", { sources: [] }),
      ],
      db: {
        now: () => new Date(FROZEN_NOW_MS).toISOString(),
        listStaleRevisionSessions: () =>
          Promise.resolve([
            {
              id: "wedged-tail",
              harness: "claude",
              status: "active",
              lastActivityAt: hoursBeforeFrozenNow(48),
            },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(true),
        // Present and CLEAN, so the repair tail reports every missing-source id
        // as stamp-ready. Without this the tail withholds the whole cohort and
        // the case would pass whether or not the guard exists.
        recomputeAnalyticsRollups: (sessionIds: string[]) =>
          Promise.resolve({
            attempted: sessionIds.length,
            committed: sessionIds.length,
            failed: 0,
            failedIds: [],
          }),
        rebuildComponentInvocationsFromStoredRows: (sessionId: string) => {
          stampedIds.push(sessionId);
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
      },
    });

    assert.equal(summary.wedgedActiveAdmitted, 1, "it was admitted");
    assert.equal(
      summary.missingSource,
      1,
      "and it really did reach the repair tail — otherwise this case proves nothing"
    );
    assert.deepEqual(
      stampedIds,
      [],
      "but the bridge that stamps unconditionally never sees it"
    );
  });
});
