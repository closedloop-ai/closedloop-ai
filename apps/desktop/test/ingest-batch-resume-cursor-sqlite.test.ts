/**
 * @file ingest-batch-resume-cursor-sqlite.test.ts
 * @description ISS-9839: the ISS-5161 batch-resume cursor persists to the
 * `ingest_batch_resume_cursor` SQLite table, not to a JSON file in the ingest
 * state dir.
 *
 * The sibling `ingest-batch-resume-cursor-store.test.ts` drives an in-memory
 * stand-in for the port, because the behaviors it pins belong to
 * `BatchResumeCursors`. These cases are the ones that would still pass against
 * that stand-in while the production medium was wrong, so they run against a
 * real libSQL database built by the production migration runner:
 *
 *  - the cursor round-trips through the real row, so a second process reads what
 *    the first wrote;
 *  - a version bump discards the WHOLE store (ISS-9837 R3) rather than retaining
 *    rows a newer build would misread, and nothing survives it;
 *  - `byteLength` reports BYTES from the row, which is what the pre-read ceiling
 *    is expressed in.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { BatchResumeCursors } from "../src/main/collectors/engine/collector-manager-batch-resume.js";
import { sqliteBatchResumeCursorStore } from "./helpers/batch-resume-cursor-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const OPENCODE = "opencode";
const STORE_SOURCE = "/store.db";
const FINGERPRINT = "opencode.db:1000:512";
/**
 * The format version the current build writes, declared HERE rather than
 * imported from the module under test: a test that reads its expectation from
 * the constant it polices cannot fail when that constant is changed or deleted.
 * The duplication IS the test (mirrors `codex-collector-surface.test.ts`).
 */
const CURRENT_PERSIST_VERSION = 2;

type CursorRow = {
  id: string;
  version: number | bigint;
  cursors: string;
};

test("ISS-9839: the batch resume cursor round-trips through the SQLite table", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    const store = sqliteBatchResumeCursorStore(prisma);
    const writer = new BatchResumeCursors({ store });
    await writer.noteImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT);
    await writer.noteImported(OPENCODE, STORE_SOURCE, "s2", FINGERPRINT);
    await writer.flush();

    // The row itself, read straight out of SQLite: the cursor is in the database
    // rather than in a file, and it carries the store-wide format version.
    const rows = await db.query<CursorRow>(
      'SELECT "id", "version", "cursors" FROM "ingest_batch_resume_cursor"'
    );
    assert.equal(
      rows.rows.length,
      1,
      "the cursor is ONE whole-store row, never a row per source"
    );
    const row = rows.rows[0];
    assert.equal(Number(row?.version), CURRENT_PERSIST_VERSION);
    assert.deepEqual(JSON.parse(row?.cursors ?? "null"), {
      [`${OPENCODE} ${STORE_SOURCE}`]: {
        fingerprint: FINGERPRINT,
        sessionIds: ["s1", "s2"],
      },
    });

    // And a fresh cursor over the same database resumes from it — the
    // process-restart read this store exists for.
    const reader = new BatchResumeCursors({ store });
    assert.equal(
      await reader.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT),
      true
    );
    assert.equal(
      await reader.isImported(OPENCODE, STORE_SOURCE, "s3", FINGERPRINT),
      false
    );
  } finally {
    await close();
  }
});

test("ISS-9839: a stored cursor written under a different format version is discarded WHOLESALE", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    const store = sqliteBatchResumeCursorStore(prisma);
    // Two sources, both perfectly well-formed for the CURRENT shape, stored under
    // a version this build does not know. Two of them rather than one so a
    // partial/selective retention is distinguishable from a total discard.
    await store.write({
      version: CURRENT_PERSIST_VERSION + 1,
      cursors: JSON.stringify({
        [`${OPENCODE} ${STORE_SOURCE}`]: {
          fingerprint: FINGERPRINT,
          sessionIds: ["s1", "s2"],
        },
        [`${OPENCODE} /other.db`]: {
          fingerprint: FINGERPRINT,
          sessionIds: ["s3"],
        },
      }),
    });

    const reported: string[] = [];
    const loaded = new BatchResumeCursors({
      store,
      log: (message) => reported.push(message),
    });
    assert.equal(
      await loaded.size(),
      0,
      "a foreign format version discards every source, not the ones it can still parse"
    );
    for (const [source, sessionId] of [
      [STORE_SOURCE, "s1"],
      [STORE_SOURCE, "s2"],
      ["/other.db", "s3"],
    ] as const) {
      assert.equal(
        await loaded.isImported(OPENCODE, source, sessionId, FINGERPRINT),
        false,
        `no session recorded under the foreign version may fast-forward (${source} ${sessionId})`
      );
    }
    assert.deepEqual(
      reported,
      [],
      "a format change across an upgrade is expected, not corruption, so it is silent"
    );

    // AC5: nothing from the discarded payload is carried forward. The next flush
    // replaces the row outright, so the stored cursor holds only what THIS build
    // recorded.
    await loaded.noteImported(OPENCODE, STORE_SOURCE, "s9", FINGERPRINT);
    await loaded.flush();
    const rows = await db.query<CursorRow>(
      'SELECT "id", "version", "cursors" FROM "ingest_batch_resume_cursor"'
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(Number(rows.rows[0]?.version), CURRENT_PERSIST_VERSION);
    assert.deepEqual(JSON.parse(rows.rows[0]?.cursors ?? "null"), {
      [`${OPENCODE} ${STORE_SOURCE}`]: {
        fingerprint: FINGERPRINT,
        sessionIds: ["s9"],
      },
    });
  } finally {
    await close();
  }
});

test("ISS-9839: byteLength reports the stored payload's size in BYTES, and nothing when no cursor is stored", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = sqliteBatchResumeCursorStore(prisma);
    assert.equal(
      await store.byteLength(),
      null,
      "an absent cursor is `null`, never 0 — the load path tells the two apart"
    );

    // A multi-byte source key: `length()` on TEXT would count CHARACTERS and
    // understate the payload, letting an over-ceiling cursor through the
    // pre-read bound the ceiling exists to enforce.
    const cursors = JSON.stringify({
      "opencode /ünïcödé-store.db": {
        fingerprint: FINGERPRINT,
        sessionIds: ["s1"],
      },
    });
    await store.write({ version: CURRENT_PERSIST_VERSION, cursors });
    assert.equal(await store.byteLength(), Buffer.byteLength(cursors, "utf8"));
    assert.ok(
      Buffer.byteLength(cursors, "utf8") > cursors.length,
      "the fixture must actually contain multi-byte characters, or this proves nothing"
    );
  } finally {
    await close();
  }
});
