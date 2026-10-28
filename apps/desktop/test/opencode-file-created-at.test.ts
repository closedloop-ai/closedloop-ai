/**
 * @file opencode-file-created-at.test.ts
 * @description ISS-12251 (PLN-2176 T-6.1/T-6.2): OpenCode stamps
 * `fileCreatedAt` from the session row's `time_created`, omits it when that cell
 * is unusable, and the materialized transcript carries it across (and still
 * parses a header written before the field existed).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { parseOpenCodeTranscript } from "@repo/lib/harness/opencode/parse-opencode";
import { afterEach, describe, test } from "vitest";
import { opencodeFileCreatedAt } from "../src/main/collectors/opencode/opencode-file-created-at.js";
import {
  loadOpencodeSessionsFromDb,
  loadSessionsFromDb,
} from "../src/main/collectors/opencode/opencode-parser.js";
import { serializeSessionToJsonl } from "../src/main/transcript-sync/opencode-materializer.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import {
  TIME_CREATED,
  TIME_UPDATED,
  UNPARSEABLE_TIMESTAMP,
  writeOpencodeDb,
} from "./opencode-store-fixture.js";

afterEach(cleanupTempDirs);

describe("opencodeFileCreatedAt", () => {
  test("uses a usable time_created", () => {
    const reports: string[] = [];
    const report = (message: string) => reports.push(message);
    assert.deepEqual(
      opencodeFileCreatedAt(TIME_CREATED, TIME_UPDATED, report),
      { fileCreatedAt: TIME_CREATED }
    );
    assert.deepEqual(
      opencodeFileCreatedAt(BigInt(TIME_CREATED), null, report),
      { fileCreatedAt: TIME_CREATED }
    );
    assert.deepEqual(reports, []);
  });

  test("omits an absent or zero time_created without reporting it", () => {
    for (const cell of [null, undefined, 0, 0n]) {
      const reports: string[] = [];
      assert.deepEqual(
        opencodeFileCreatedAt(cell, TIME_UPDATED, (message) =>
          reports.push(message)
        ),
        {},
        String(cell)
      );
      assert.deepEqual(reports, [], String(cell));
    }
  });

  test("omits and reports a negative, non-finite, out-of-range or non-numeric time_created", () => {
    for (const cell of [
      -3,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      UNPARSEABLE_TIMESTAMP,
      "",
      new Uint8Array([1]),
    ]) {
      const reports: string[] = [];
      assert.deepEqual(
        opencodeFileCreatedAt(cell, TIME_UPDATED, (message) =>
          reports.push(message)
        ),
        {},
        String(cell)
      );
      assert.equal(reports.length, 1, String(cell));
      assert.ok(reports[0]?.includes("time_created"), String(cell));
    }
  });

  test("omits a time_created later than time_updated", () => {
    assert.deepEqual(
      opencodeFileCreatedAt(TIME_UPDATED + 1, TIME_UPDATED, () => undefined),
      {}
    );
  });
});

describe("OpenCode loader and materialized transcript", () => {
  test("fileCreatedAt survives materialization, and its absence stays absent", async () => {
    const dbPath = writeOpencodeDb(makeTempDir("opencode-created-"), [
      { id: "ses_created" },
    ]);
    const [session] = loadSessionsFromDb(dbPath);
    assert.ok(session, "expected a parsed OpenCode session");
    const lines = (s: typeof session) =>
      serializeSessionToJsonl(s).trimEnd().split("\n");

    const withField = await parseOpenCodeTranscript(lines(session));
    assert.equal(withField?.fileCreatedAt, TIME_CREATED);

    const { fileCreatedAt: _omitted, ...older } = session;
    const withoutField = await parseOpenCodeTranscript(lines(older));
    assert.ok(withoutField, "a header without fileCreatedAt still parses");
    assert.equal("fileCreatedAt" in withoutField, false);
  });

  test("a corrupt time_created is reported on the monitored channel, naming the session", () => {
    const dbPath = writeOpencodeDb(makeTempDir("opencode-created-bad-"), [
      { id: "ses_bad_created" },
      { id: "ses_ok_created" },
    ]);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE session SET time_created = ? WHERE id = ?").run(
        -3,
        "ses_bad_created"
      );
    } finally {
      db.close();
    }

    const logs: string[] = [];
    const load = loadOpencodeSessionsFromDb(dbPath, {
      log: (message) => logs.push(message),
    });
    const byId = new Map(load.sessions.map((s) => [s.sessionId, s]));
    assert.equal(
      "fileCreatedAt" in (byId.get("opencode-ses_bad_created") ?? {}),
      false
    );
    assert.equal(
      byId.get("opencode-ses_ok_created")?.fileCreatedAt,
      TIME_CREATED
    );
    assert.ok(
      logs.some(
        (message) =>
          message.includes("time_created") &&
          message.includes("ses_bad_created")
      ),
      "the corrupt cell is reported, naming the session"
    );
    assert.ok(
      !logs.some((message) => message.includes("ses_ok_created")),
      "a usable time_created reports nothing"
    );
  });
});
