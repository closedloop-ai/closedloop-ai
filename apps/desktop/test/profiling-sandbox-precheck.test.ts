/**
 * ISS-7785 — the perf sandbox preconditions.
 *
 * These are the safeguards that stop the Sessions lane from spending twenty
 * minutes measuring an empty list. The workload itself is a Playwright runner
 * that CI never executes, so without this file the checks ship with no automated
 * coverage at all and a revert would be silently green.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  DESKTOP_DB_FILE_NAME,
  requireSandboxDatabase,
  requireSandboxSessions,
  SESSIONS_PAGE_SIZE,
} from "./perf/helpers/perf-run.js";

const PREP_CLI_REMEDY = /perf-prepare-dataset/;
const SESSIONS_TABLE_MENTION = /sessions/;
const ZERO_SESSIONS_REFUSAL = /ZERO sessions/;
const CONFIRMING_QUERY = /max\(last_activity_at\)/;
const AT_MOST_ONE_PAGE_WARNING = /no more than one/;

let sandboxDir = "";

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(tmpdir(), "perf-sandbox-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(sandboxDir, { recursive: true, force: true });
});

/** A sandbox holding `count` sessions, like the dataset CLI produces. */
function seedSandbox(count: number): string {
  const dbPath = path.join(sandboxDir, DESKTOP_DB_FILE_NAME);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, last_activity_at TEXT)");
  const insert = db.prepare(
    "INSERT INTO sessions (id, last_activity_at) VALUES (?, ?)"
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(`session-${index}`, "2026-05-19T00:00:00.000Z");
  }
  db.close();
  return dbPath;
}

describe("requireSandboxDatabase — every lane's floor", () => {
  test("refuses a directory with no Desktop store", () => {
    assert.throws(() => requireSandboxDatabase(sandboxDir), PREP_CLI_REMEDY);
  });

  test("refuses a file that is not a readable Desktop store", () => {
    writeFileSync(
      path.join(sandboxDir, DESKTOP_DB_FILE_NAME),
      "not a database",
      "utf8"
    );

    assert.throws(
      () => requireSandboxDatabase(sandboxDir),
      SESSIONS_TABLE_MENTION
    );
  });

  test("accepts an EMPTY corpus and returns the store path", () => {
    // The floor deliberately says nothing about population. The branches lane
    // builds its own corpus and must not be failed by a thin Sessions table.
    const dbPath = seedSandbox(0);

    assert.equal(requireSandboxDatabase(sandboxDir), dbPath);
  });
});

describe("requireSandboxSessions — the Sessions lane's precondition", () => {
  test("refuses a zero-session corpus, naming the confirming query", () => {
    seedSandbox(0);

    assert.throws(
      () => requireSandboxSessions(sandboxDir),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // The whole point is that the operator can act on it: the message has to
        // say what is wrong and how to confirm it, not just fail.
        assert.match(message, ZERO_SESSIONS_REFUSAL);
        assert.match(message, CONFIRMING_QUERY);
        return true;
      }
    );
  });

  test("warns but proceeds when the corpus is under one page", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedSandbox(SESSIONS_PAGE_SIZE - 1);

    requireSandboxSessions(sandboxDir);

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.[0]), AT_MOST_ONE_PAGE_WARNING);
  });

  // The boundary the `<` spelling got wrong. Exactly one full page is still one
  // page: `TablePagination` returns null at `totalPages <= 1`, so no next-page
  // control renders and `paginate-1` waits out its full bound instead of
  // reaching the `aria-disabled` end-of-list path. Turning a page needs a SECOND
  // page, so this corpus is exactly as unmeasurable as a short one.
  test("warns at exactly one full page, which has no next page to turn to", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedSandbox(SESSIONS_PAGE_SIZE);

    requireSandboxSessions(sandboxDir);

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.[0]), AT_MOST_ONE_PAGE_WARNING);
  });

  test("is silent once a second page exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedSandbox(SESSIONS_PAGE_SIZE + 1);

    requireSandboxSessions(sandboxDir);

    assert.equal(warn.mock.calls.length, 0);
  });
});
