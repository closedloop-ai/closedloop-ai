/**
 * @file billing-mode-heal-bailout.test.ts
 * @description ISS-7581. The two branches where the billing-mode heal STOPS
 * early, both of which report success-shaped output on the way out.
 *
 * Split from `billing-mode-heal.test.ts` rather than appended to it: that file
 * covers what the drain does when its statements succeed — the bounded set, the
 * keyset, the per-harness stamping — and these cover what it does when they do
 * not. The two answer different questions about the same pass, and the shared
 * seed and log patterns live in `billing-mode-heal-test-helpers.ts` so neither
 * file owns the other's fixture.
 *
 * Both cases assert CONVERGENCE rather than just the bail-out. A pass that gives
 * up is only correct if the rows it skipped stay eligible, so each one drives a
 * second, healthy pass and proves the store reaches the state the first pass
 * failed to produce. Asserting the early return alone would stay green against a
 * bail-out that also poisoned the rows behind it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { healUnknownBillingModes } from "../src/main/database/billing-mode-heal.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  HEAL_COMPLETE_RE,
  HEAL_FAILED_COPILOT_RE,
  insertSession,
  LOCKED_REASON_RE,
  RESTAMPED_ONE_RE,
  readBillingMode,
} from "./billing-mode-heal-test-helpers.js";

test("ISS-7581: a failed chunk read returns the tally healed so far", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-read-fail-"));
  const db = await openTestDb(dir);
  try {
    for (const id of ["s-a", "s-b"]) {
      await insertSession(db, {
        id,
        harness: "copilot",
        billingMode: "unknown",
      });
    }

    const failing = failSecondChunkSelect(db.prisma);
    const logs: string[] = [];
    await healUnknownBillingModes(
      failing.prisma,
      (message) => logs.push(message),
      1
    );

    assert.equal(failing.attempts(), 2, "the failed read ends the chunk drain");
    assert.equal(await readBillingMode(db, "s-a"), "copilot_seat");
    assert.equal(await readBillingMode(db, "s-b"), "unknown");
    assert.equal(logs.length, 2, "one failure and one partial completion");
    assert.match(logs[0], HEAL_FAILED_COPILOT_RE);
    assert.match(logs[0], LOCKED_REASON_RE);
    assert.match(logs[1], RESTAMPED_ONE_RE);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7581: three failed chunks stop the pass and a later boot converges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-fail-cap-"));
  const db = await openTestDb(dir);
  try {
    const ids = ["s-a", "s-b", "s-c", "s-d"];
    for (const id of ids) {
      await insertSession(db, {
        id,
        harness: "copilot",
        billingMode: "unknown",
      });
    }

    const failing = failEveryWrite(db.prisma);
    const firstLogs: string[] = [];
    await healUnknownBillingModes(
      failing.prisma,
      (message) => firstLogs.push(message),
      1
    );

    assert.equal(failing.attempts(), 3, "the lane-wide failure is bounded");
    assert.equal(firstLogs.length, 3);
    for (const log of firstLogs) {
      assert.match(log, HEAL_FAILED_COPILOT_RE);
      assert.match(log, LOCKED_REASON_RE);
      assert.doesNotMatch(log, HEAL_COMPLETE_RE);
    }
    for (const id of ids) {
      assert.equal(await readBillingMode(db, id), "unknown");
    }

    const secondLogs: string[] = [];
    await healUnknownBillingModes(
      db.prisma,
      (message) => secondLogs.push(message),
      1
    );
    for (const id of ids) {
      assert.equal(await readBillingMode(db, id), "copilot_seat");
    }
    assert.equal(secondLogs.length, 1);
    assert.match(secondLogs[0], RESTAMPED_FOUR_RE);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Reject the pass's SECOND chunk-id read and let every other statement run for
 * real. The chunk-SELECT catch is the seam under test: it logs and returns the
 * tally so far, so a drain that instead threw or retried the same chunk forever
 * would fail on `attempts()` rather than on the healed rows.
 */
function failSecondChunkSelect(prisma: DesktopPrisma): {
  prisma: DesktopPrisma;
  attempts: () => number;
} {
  let attempts = 0;
  const client = new Proxy(prisma.client, {
    get(target, property, receiver) {
      if (property !== "$queryRawUnsafe") {
        return Reflect.get(target, property, receiver);
      }
      return <T>(query: string, ...values: unknown[]): Promise<T> => {
        if (!query.startsWith("SELECT id FROM sessions")) {
          return target.$queryRawUnsafe<T>(query, ...values);
        }
        attempts += 1;
        if (attempts === 2) {
          return Promise.reject(new Error("database is locked"));
        }
        return target.$queryRawUnsafe<T>(query, ...values);
      };
    },
  });
  return {
    prisma: { ...prisma, client },
    attempts: () => attempts,
  };
}

/**
 * Reject EVERY chunk write, which is the lane-wide-failure shape
 * `MAX_CONSECUTIVE_FAILED_CHUNKS` bounds. `attempts()` pins the cap at exactly
 * three: the constant existed in production with no test naming it, so a drain
 * that kept retrying every remaining chunk was indistinguishable from one that
 * gave up.
 */
function failEveryWrite(prisma: DesktopPrisma): {
  prisma: DesktopPrisma;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    prisma: {
      ...prisma,
      write: <T>(): Promise<T> => {
        attempts += 1;
        return Promise.reject(new Error("database is locked"));
      },
    },
    attempts: () => attempts,
  };
}

const RESTAMPED_FOUR_RE = /re-stamped 4 session\(s\)/;
