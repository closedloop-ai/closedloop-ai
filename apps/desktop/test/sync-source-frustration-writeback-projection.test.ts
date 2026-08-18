/**
 * ISS-6273: `persistLocalFrustration` caches the sync-time frustration signal
 * back onto each `sessions` row on the READ path — it runs inside
 * `loadSyncedSessions`, which the Sessions 2-second poll drives. A Prisma
 * `update` emits `UPDATE … RETURNING <every scalar column>`, so each of those
 * per-session write-backs handed the full row — `metadata` included — straight
 * back across the driver boundary to be discarded, on the same call where
 * ISS-6119's `json_remove` projection had just stripped that blob on the way in.
 *
 * The result is discarded (`Promise<void>`), so `updateMany` is output-identical
 * by type: no corpus differential is owed for the parity claim. What IS owed is
 * proof that the wide RETURNING is gone, which is what these tests pin — against
 * the real SQLite → `loadSyncedSessions` boundary, through the ISS-5336
 * statement spy, so they observe the SQL the production path actually emits
 * rather than a hand-copied statement.
 *
 * WHY THE CONTROL IS A WRITE, NOT A READ. The assertions below are ABSENCE
 * assertions, and the spy's scope is the adapter's `queryRaw` — NOT `executeRaw`
 * (which is where `updateMany` lands) and NOT a transaction's own statements. So
 * "no UPDATE was captured" is indistinguishable from "the spy does not watch
 * this path" unless something proves the instrument can see a writer-side
 * RETURNING. A read-side control cannot do that: hydration reads run on the
 * READER pool (`prisma.read`) while the write-back runs on the WRITER
 * (`prisma.write`). `armSpy` therefore issues a deliberate `session.update` on
 * the writer and each test asserts THAT was captured, through the very regexes
 * the absence assertions use — so a spy that stops watching the writer, or an
 * adapter/Prisma upgrade that changes the captured SQL, fails loudly here
 * instead of turning the absence assertions into tautologies.
 *
 * KNOWN RESIDUAL, measured rather than assumed: `spyOnAdapterQueries` proxies
 * only the connection's `queryRaw`, and `startTransaction` returns an UNPROXIED
 * `Transaction`. A control issued outside a transaction is captured; the same
 * `update` issued inside `$transaction` is captured zero times. So if this loop
 * were ever batched into an interactive `$transaction`, a regression to `update`
 * would restore the 26-column RETURNING with this suite still green, and no
 * control that runs outside a transaction can detect it. That case is outside
 * this test's reach; the guard against it is that the loop does not use one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { CapturedStatement } from "../src/main/database/prisma-client.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import { persistLocalFrustration } from "../src/main/database/sync-source-frustration-writeback.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const SESSION_IDS = ["sess-frustration-a", "sess-frustration-b"] as const;
const MISSING_SESSION_ID = "sess-frustration-deleted-mid-poll";

/**
 * The control write's value. Negative is unreachable for a real signal — the
 * scorer sums non-negative contributions — so a later assertion that the
 * write-back replaced it cannot be satisfied by the control itself.
 */
const CONTROL_SENTINEL = -1;

/**
 * A `metadata` blob big enough that a RETURNING carrying it is unmistakable in
 * the captured SQL, and representative of the real column ISS-6119 strips.
 */
const METADATA_BLOB = JSON.stringify({
  note: "the raw blob ISS-6119 strips on the way in",
  padding: "m".repeat(2048),
});

// The engine quotes with backticks (`UPDATE `main`.`sessions``) while this
// module's own raw reads are unquoted (`FROM sessions`), so both forms — and the
// optional schema qualifier — have to be accepted or an assertion silently stops
// matching the statement it exists to catch. The trailing boundary keeps a
// future `sessions_fts`/`sessions_archive` from matching as `sessions`.
const QUOTE = String.raw`[\`"]?`;
const SESSIONS_TABLE = `${QUOTE}(?:main${QUOTE}\\.${QUOTE})?sessions${QUOTE}(?![\\w])`;
/** Any statement the engine issued against `sessions` as a row-returning query. */
const SESSIONS_READ_RE = new RegExp(String.raw`from\s+${SESSIONS_TABLE}`, "i");
/** An UPDATE of `sessions` — the shape that only reaches the spy via RETURNING. */
const SESSIONS_UPDATE_RE = new RegExp(
  String.raw`update\s+${SESSIONS_TABLE}`,
  "i"
);
const RETURNING_RE = /\breturning\b/i;
const METADATA_COLUMN_RE = /\bmetadata\b/i;

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

type StoredFrustration = { raw: number | null; version: number | null };

type SpiedContext = {
  captured: CapturedStatement[];
  source: ReturnType<typeof createSqliteSessionSyncSource>;
  /**
   * Prove the spy sees a writer-side RETURNING, then hand back the control's
   * captured statements and clear the buffer. The caller asserts on the return
   * value, so the proof lives in the test body rather than inside this helper.
   */
  armSpy: () => Promise<CapturedStatement[]>;
  readFrustration: (id: string) => Promise<StoredFrustration>;
  clearFrustration: () => Promise<void>;
  persist: (
    sessions: readonly Parameters<typeof persistLocalFrustration>[1][number][]
  ) => Promise<void>;
};

async function withSpiedSyncSource<T>(
  run: (context: SpiedContext) => Promise<T>
): Promise<T> {
  const captured: CapturedStatement[] = [];
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    for (const id of SESSION_IDS) {
      // Seeded through `$executeRawUnsafe`, which the adapter serves on
      // `executeRaw` — so the seed itself never lands in `captured` and cannot
      // be mistaken for a statement the path under test emitted.
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO sessions (id, status, started_at, updated_at, ended_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          SESSION_STATUS.INACTIVE,
          "2026-08-13T00:00:00.000Z",
          "2026-08-13T06:00:00.000Z",
          "2026-08-13T05:00:00.000Z",
          METADATA_BLOB
        )
      );
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO events (id, session_id, event_type, created_at, summary)
           VALUES (?, ?, ?, ?, ?)`,
          `${id}-evt-1`,
          id,
          "UserPromptSubmit",
          "2026-08-13T00:10:00.000Z",
          "this is broken again, please fix it"
        )
      );
    }
    return await run({
      captured,
      source: createSqliteSessionSyncSource(prisma),
      armSpy: async () => {
        captured.length = 0;
        await prisma.write((client) =>
          client.session.update({
            where: { id: SESSION_IDS[0] },
            data: { frustrationRaw: CONTROL_SENTINEL },
          })
        );
        const control = [...captured];
        captured.length = 0;
        return control;
      },
      readFrustration: async (id) => {
        const row = await prisma.read((reader) =>
          reader.session.findUnique({
            where: { id },
            select: { frustrationRaw: true, frustrationScoreVersion: true },
          })
        );
        return {
          raw: row?.frustrationRaw ?? null,
          version: row?.frustrationScoreVersion ?? null,
        };
      },
      clearFrustration: async () => {
        await prisma.write((client) =>
          client.$executeRawUnsafe(
            "UPDATE sessions SET frustration_raw = NULL, frustration_score_version = NULL"
          )
        );
      },
      persist: (sessions) => persistLocalFrustration(prisma, sessions),
    });
  } finally {
    await close();
  }
}

test("ISS-6273: the frustration write-back returns no columns on the read path", async () => {
  await withSpiedSyncSource(
    async ({ captured, source, armSpy, readFrustration }) => {
      // The instrument proves itself on the connection and API under test
      // BEFORE anything is asserted absent.
      const control = await armSpy();
      const controlUpdates = control.filter((statement) =>
        SESSIONS_UPDATE_RE.test(statement.sql)
      );
      assert.equal(
        controlUpdates.length,
        1,
        `the spy captures a writer-side sessions UPDATE, so an absent one is a real absence — got: ${JSON.stringify(control.map((s) => s.sql))}`
      );
      assert.match(
        controlUpdates[0].sql,
        RETURNING_RE,
        "and it captures the RETURNING clause the absence assertions look for"
      );
      assert.match(
        controlUpdates[0].sql,
        METADATA_COLUMN_RE,
        "and a wide RETURNING really does carry `metadata` on this schema"
      );

      const sessions = await source.loadSyncedSessions(
        [...SESSION_IDS],
        emptyAttributionCache()
      );
      assert.equal(
        sessions.length,
        SESSION_IDS.length,
        "both sessions hydrated"
      );

      // Non-vacuity: the write-back actually ran on this call. Without it, a
      // change that made the filter drop every session would satisfy every
      // absence assertion below for the wrong reason.
      const stored = await readFrustration(SESSION_IDS[0]);
      assert.notEqual(
        stored.raw,
        CONTROL_SENTINEL,
        "the write-back replaced the control sentinel — it ran on this call"
      );

      assert.ok(
        captured.some((statement) => SESSIONS_READ_RE.test(statement.sql)),
        "the spy also observed the read path's own `sessions` reads"
      );

      const updates = captured.filter((statement) =>
        SESSIONS_UPDATE_RE.test(statement.sql)
      );
      assert.deepEqual(
        updates.map((statement) => statement.sql),
        [],
        "no `sessions` UPDATE reaches the row-returning path — a discarded write-back must not RETURN"
      );

      const returningMetadata = captured.filter(
        (statement) =>
          RETURNING_RE.test(statement.sql) &&
          METADATA_COLUMN_RE.test(statement.sql)
      );
      assert.deepEqual(
        returningMetadata.map((statement) => statement.sql),
        [],
        "nothing on the read path RETURNs `metadata` — the blob ISS-6119 strips is not handed back"
      );
    }
  );
});

test("ISS-6273: the write-back still persists the frustration cache for every session", async () => {
  await withSpiedSyncSource(async ({ source, readFrustration }) => {
    const sessions = await source.loadSyncedSessions(
      [...SESSION_IDS],
      emptyAttributionCache()
    );
    assert.equal(sessions.length, SESSION_IDS.length, "both sessions hydrated");

    for (const session of sessions) {
      const stored = await readFrustration(session.externalSessionId);
      assert.equal(
        stored.raw,
        session.frustrationRaw,
        `${session.externalSessionId} cached the payload's frustrationRaw`
      );
      assert.equal(
        stored.version,
        session.frustrationScoreVersion,
        `${session.externalSessionId} cached the payload's scorer version`
      );
      assert.equal(
        typeof stored.raw,
        "number",
        "the cached signal is a real number, not a NULL left by a skipped write"
      );
    }
  });
});

test("ISS-6273: a session deleted mid-poll no longer aborts the rest of the write-back", async () => {
  // The behavior delta the switch buys, and the reason it is safe here: `update`
  // throws P2025 on a missing row and abandons every session after it in the
  // loop; `updateMany` matches nothing and carries on. The missing id is placed
  // FIRST so a regression to `update` leaves the surviving session unwritten.
  await withSpiedSyncSource(
    async ({ source, persist, readFrustration, clearFrustration }) => {
      const sessions = await source.loadSyncedSessions(
        [...SESSION_IDS],
        emptyAttributionCache()
      );
      const survivor = sessions.find(
        (session) => session.externalSessionId === SESSION_IDS[1]
      );
      assert.ok(survivor, "the surviving session hydrated");

      await clearFrustration();
      assert.equal(
        (await readFrustration(SESSION_IDS[1])).raw,
        null,
        "the cache starts empty, so a pass-through cannot be mistaken for a write"
      );

      await persist([
        { ...survivor, externalSessionId: MISSING_SESSION_ID },
        survivor,
      ]);

      const stored = await readFrustration(SESSION_IDS[1]);
      assert.equal(
        stored.raw,
        survivor.frustrationRaw,
        "the session AFTER the missing one still got its cache written"
      );
      assert.equal(
        (await readFrustration(MISSING_SESSION_ID)).raw,
        null,
        "and nothing was conjured for the id that has no row"
      );
    }
  );
});

test("ISS-6273: a session with no frustration signal is filtered out, not written as null", async () => {
  await withSpiedSyncSource(
    async ({ source, persist, readFrustration, clearFrustration }) => {
      const sessions = await source.loadSyncedSessions(
        [...SESSION_IDS],
        emptyAttributionCache()
      );
      const withoutRaw = sessions.find(
        (session) => session.externalSessionId === SESSION_IDS[0]
      );
      const withoutVersion = sessions.find(
        (session) => session.externalSessionId === SESSION_IDS[1]
      );
      assert.ok(withoutRaw, "the missing-`frustrationRaw` case hydrated");
      assert.ok(
        withoutVersion,
        "the missing-`frustrationScoreVersion` case hydrated"
      );

      await clearFrustration();
      // Each half of the two-field predicate gets its OWN session, and BOTH
      // stored columns are read back. Sharing one row and asserting only `raw`
      // could not fail on the mutation it exists to catch: dropping the
      // `frustrationRaw` half admits the first case, which then writes
      // `frustration_score_version` while `frustration_raw` stays NULL.
      // `frustrationRaw`/`frustrationScoreVersion` are `number | null |
      // undefined` on the contract, so an unscored session is reachable, not a
      // type-forbidden input.
      await persist([
        { ...withoutRaw, frustrationRaw: null },
        { ...withoutVersion, frustrationScoreVersion: null },
      ]);

      for (const id of SESSION_IDS) {
        assert.deepEqual(
          await readFrustration(id),
          { raw: null, version: null },
          `${id}: an unscored session is skipped entirely — neither column is written, no fabricated value`
        );
      }
    }
  );
});
