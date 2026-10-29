/**
 * @file synced-session-hydration-durable-log.test.ts
 * @description ISS-6204 — pin the DURABLE warning a hydration sizing-read
 * failure records.
 *
 * `synced-session-hydration-plan.test.ts` already owns the chunk-preservation
 * half of that degrade (every id survives, in order, in fixed 200-id chunks) and
 * keeps owning it; this file owns the WARNING, which nothing asserted before:
 * it was observable only through the FEA-3568 diagnostic callback, so deleting
 * the `writePersistentLog` call left every test green.
 *
 * The three cases are different in kind. The first drives the injected seam and
 * asserts the level, the scope and the exact wording. The second drives the
 * FOUR-ARGUMENT call `sync-source.ts` actually makes — no seam supplied — and
 * reads the line back off a redirected `main.log`, which is what rules out a
 * default that silently no-ops. The third drives a sizing read that SUCCEEDS and
 * asserts SILENCE on both sinks, which is what separates a warning bound to the
 * degrade from one that fires on every hydration.
 *
 * WHAT THE SECOND CASE DOES AND DOES NOT PROVE: it establishes that the DEFAULT
 * is the real `writePersistentLog` and that the production call shape reaches a
 * file, in a process that has initialized durable logging. It says nothing about
 * the db-host `utilityProcess`, which initializes none — ISS-7882 made that
 * process route its durable lines to main instead, and
 * `db-host-durable-log-relay.test.ts` owns the proof that they land.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { planSyncedSessionHydration } from "../src/main/database/synced-session-hydration-plan.js";
import {
  electronLog,
  initializePersistentLogging,
} from "../src/main/logging/persistent-log.js";

/**
 * The expected wording, level and scope are pinned as LITERALS on purpose.
 * Rebuilding them from `sizingDegradeMessage` / `HYDRATION_SIZING_LOG_SCOPE`
 * would assert that a formatter equals itself and would follow any edit to the
 * message straight through; the duplication is what makes this a test.
 */
const EXPECTED_LEVEL = "warn";
const EXPECTED_SCOPE = "sync-source";
const EXPECTED_MESSAGE =
  "sync-source: hydration sizing read failed for 3 session(s); falling back to fixed 200-id chunks: reader unavailable";
const DURABLE_LINE_RE =
  /\[warn]\s+\[sync-source] sync-source: hydration sizing read failed for 3 session\(s\); falling back to fixed 200-id chunks: reader unavailable/;

const IDS = ["s0", "s1", "s2"];
const SIZING_READ_ERROR = "reader unavailable";

const logDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "synced-session-hydration-durable-log-")
);
const logPath = path.join(logDir, "main.log");
const originalLogPathResolver = electronLog.transports.file.resolvePathFn;

beforeAll(() => {
  electronLog.transports.file.resolvePathFn = () => logPath;
  initializePersistentLogging();
});

afterAll(() => {
  electronLog.transports.file.resolvePathFn = originalLogPathResolver;
  fs.rmSync(logDir, { force: true, recursive: true });
});

describe("ISS-6204: the hydration sizing degrade writes a durable warning", () => {
  test("reports the degrade at warn level, on the hydration scope, with the generated wording", async () => {
    const durable: { level: string; scope: string; message: string }[] = [];

    await planSyncedSessionHydration(
      failingPrisma(),
      IDS,
      { omitEventData: true },
      () => undefined,
      (level, scope, message) => durable.push({ level, scope, message })
    );

    assert.equal(
      durable.length,
      1,
      "the degrade writes exactly one durable warning, not zero and not one per id"
    );
    assert.deepEqual(durable[0], {
      level: EXPECTED_LEVEL,
      scope: EXPECTED_SCOPE,
      message: EXPECTED_MESSAGE,
    });
  });

  test("the four-argument production call invokes the real writePersistentLog default", async () => {
    // `sync-source.ts` calls `planSyncedSessionHydration(prisma, ids, options,
    // log)` and supplies no seam, so this is the shape that has to work. A seam
    // whose default silently no-opped would pass the case above and prove
    // nothing; the redirected `main.log` is what rules that out. See the file
    // docstring for what this deliberately does NOT claim about the db-host
    // process.
    const offsetBefore = logByteLength();

    await planSyncedSessionHydration(
      failingPrisma(),
      IDS,
      { omitEventData: true },
      () => undefined
    );

    assert.match(logSince(offsetBefore), DURABLE_LINE_RE);
  });

  test("a sizing read that SUCCEEDS writes no durable warning", async () => {
    // The other direction, and the reason the cases above are not enough on
    // their own: `durable.length === 1` on a failing read is equally consistent
    // with a warning that fires unconditionally. Only a healthy read proves the
    // warning is bound to the DEGRADE rather than to the code path.
    const durable: { level: string; scope: string; message: string }[] = [];
    const diagnostics: string[] = [];
    const offsetBefore = logByteLength();

    const chunks = await planSyncedSessionHydration(
      healthyPrisma(),
      IDS,
      { omitEventData: true },
      (message) => diagnostics.push(message),
      (level, scope, message) => durable.push({ level, scope, message })
    );

    assert.deepEqual(durable, [], "a successful sizing read is not a degrade");
    assert.deepEqual(diagnostics, []);
    assert.equal(
      logSince(offsetBefore),
      "",
      "and nothing reaches the durable file either"
    );
    // Guards the fixture itself: a `healthyPrisma` that failed to satisfy the
    // sizing read would take the catch, and the assertions above would then be
    // vacuously true of a run that never planned anything.
    assert.deepEqual(chunks, [IDS]);
  });
});

/** A prisma whose sizing read always rejects — the degrade's entry condition. */
function failingPrisma(): DesktopPrisma {
  return {
    read: () => Promise.reject(new Error(SIZING_READ_ERROR)),
  } as unknown as DesktopPrisma;
}

/**
 * A prisma whose sizing read returns one well-formed row per id, so the planner
 * takes the normal path and never enters the degrade.
 */
function healthyPrisma(): DesktopPrisma {
  return {
    read: (
      fn: (client: { $queryRawUnsafe: () => Promise<unknown[]> }) => unknown
    ) =>
      fn({
        $queryRawUnsafe: () =>
          Promise.resolve(
            IDS.map((id) => ({
              session_id: id,
              metadata_bytes: 0,
              event_rows: 0,
              token_event_rows: 0,
              activity_segment_rows: 0,
            }))
          ),
      }),
  } as unknown as DesktopPrisma;
}

function logByteLength(): number {
  return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
}

/**
 * The tail written since `offset`. A missing file is "" rather than a throw, so
 * a deleted durable call fails on the assertion below instead of on ENOENT.
 */
function logSince(offset: number): string {
  return fs.existsSync(logPath)
    ? fs.readFileSync(logPath).subarray(offset).toString("utf8")
    : "";
}
