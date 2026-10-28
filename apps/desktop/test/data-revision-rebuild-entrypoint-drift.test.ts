/**
 * @file data-revision-rebuild-entrypoint-drift.test.ts
 * @description ISS-7260 (whitlockk review) — the DATA_REVISION rebuild is the SECOND
 * parse path, and it does not go through `collector-manager-source-parse`.
 *
 * The drift reporter originally sat on the import pass alone, under a comment
 * claiming that step was the one place every harness's parse resolves through.
 * It is not: the rebuild calls `collector.parse(source)` directly, so a boot that
 * re-derived a stale cohort could write sessions carrying an unrecognized
 * entrypoint and emit nothing — and a rebuild is exactly when an upstream rename
 * gets applied to a whole corpus at once.
 *
 * These drive the REAL `runDataRevisionRebuild` against the production
 * `openSqliteAgentDatabase` (no Electron), so deleting the reporter call from the
 * rebuild's parse-success path must fail here. The import pass keeps its own
 * coverage in `collector-entrypoint-drift-report.test.ts`; the shared reporter
 * both paths use is unit-tested in `@repo/lib`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

const DEFAULT_CLASSIFICATION_LINE = /INTERACTIVE by default/;
/**
 * Values no other case in this process uses. The reporter dedupes per distinct
 * value for the life of the process, so a value shared between two cases would
 * make the second silent for a reason that has nothing to do with the path
 * under test.
 */
const DRIFTED_ENTRYPOINT = "iss7260-rebuild-only-harness";
const SID = "iss7260-rebuild-drift";
const RECOGNIZED_SID = "iss7260-rebuild-known";

/**
 * Import `session`, mark its row stale so the rebuild picks it up, then run the
 * real rebuild over a collector that re-parses it.
 *
 * Returns every logged line PLUS the rebuilt count, which each caller asserts:
 * a rebuild that never ran parses nothing, so "no drift line" would otherwise
 * pass for entirely the wrong reason.
 */
async function rebuildAndCollectLines(
  sessionId: string,
  entrypoint: string
): Promise<{ lines: string[]; rebuilt: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7260-rebuild-"));
  const db = await openTestDb(dir);
  try {
    const session = makeSession({ sessionId, entrypoint });
    await db.importer.importSession(session, "claude");
    await db.run(
      "UPDATE sessions SET data_revision = 1, status = 'inactive' WHERE id = $1",
      sessionId
    );

    const lines: string[] = [];
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${sessionId}.jsonl`],
          parse: () => Promise.resolve([session]),
          sessionIdForSource: () => sessionId,
        }),
      ],
      db,
      log: (message) => lines.push(message),
    });
    return { lines, rebuilt: result.rebuilt };
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-7260: the DATA_REVISION rebuild reports an unrecognized entrypoint", async () => {
  const { lines, rebuilt } = await rebuildAndCollectLines(
    SID,
    DRIFTED_ENTRYPOINT
  );
  assert.equal(rebuilt, 1, "precondition: the session was rebuilt");
  const reported = lines.filter((line) => line.includes(DRIFTED_ENTRYPOINT));
  assert.equal(
    reported.length,
    1,
    `expected one drift line from the rebuild, got ${JSON.stringify(lines)}`
  );
  assert.match(reported[0], DEFAULT_CLASSIFICATION_LINE);
});

test("ISS-7260: the rebuild stays silent for a recognized entrypoint", async () => {
  // The positive sibling above is what makes this meaningful: the rebuild path
  // can report, so silence here is the classifier deciding rather than a call
  // site that was never wired.
  const { lines, rebuilt } = await rebuildAndCollectLines(
    RECOGNIZED_SID,
    "cli"
  );
  assert.equal(rebuilt, 1, "precondition: the session was rebuilt");
  assert.deepEqual(
    lines.filter((line) => DEFAULT_CLASSIFICATION_LINE.test(line)),
    []
  );
});
