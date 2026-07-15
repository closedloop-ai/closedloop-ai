/**
 * FEA-3065 — integration proof that the serialization gate actually mutually
 * excludes two concurrent holders against a REAL Postgres, and that a holder
 * outliving the budget makes a waiter fail open (statement_timeout cancels the
 * blocking acquire). Unit tests mock the client; only a real DB proves the
 * advisory-lock semantics. Skips gracefully when DATABASE_URL is unset.
 */

import { describe, expect, it } from "vitest";
import { withMigrationSerializeLock } from "../../scripts/migration-lock";

const DATABASE_URL = process.env.DATABASE_URL;

// A dedicated key for this test, distinct from the production gate key, so the
// suite is self-contained and cannot interfere with anything else.
const TEST_LOCK_KEY = 30_659_001;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

type Phase = "enter" | "exit";
type LockEvent = { who: string; phase: Phase; at: number };

function stamp(events: LockEvent[], who: string, phase: Phase): number {
  const found = events.find((e) => e.who === who && e.phase === phase);
  if (!found) {
    throw new Error(`missing event ${who}:${phase}`);
  }
  return found.at;
}

describe.skipIf(!DATABASE_URL)(
  "migration-lock serialization (integration)",
  () => {
    it("serializes two concurrent holders — no overlap (mutual exclusion)", async () => {
      const events: LockEvent[] = [];
      const url = requireUrl();

      const run = (who: string) =>
        withMigrationSerializeLock(
          { databaseUrl: url, lockKey: TEST_LOCK_KEY },
          async () => {
            events.push({ who, phase: "enter", at: Date.now() });
            await sleep(200);
            events.push({ who, phase: "exit", at: Date.now() });
          }
        );

      await Promise.all([run("A"), run("B")]);

      const aFirst = stamp(events, "A", "enter") < stamp(events, "B", "enter");
      const first = aFirst ? "A" : "B";
      const second = aFirst ? "B" : "A";

      // The second holder cannot enter its critical section until the first has
      // exited — that is the serialization guarantee.
      expect(stamp(events, second, "enter")).toBeGreaterThanOrEqual(
        stamp(events, first, "exit")
      );
    });

    it("fails open when the blocking acquire exceeds the budget", async () => {
      const url = requireUrl();
      const events: string[] = [];
      let releaseHolder: (() => void) | undefined;
      const holderReleased = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });

      // Holder A takes the lock and keeps it until we release it.
      const holder = withMigrationSerializeLock(
        { databaseUrl: url, lockKey: TEST_LOCK_KEY },
        async () => {
          events.push("A:enter");
          await holderReleased;
          events.push("A:exit");
        }
      );

      // Let A acquire (connect + set_config + acquire are sub-100ms on a local DB).
      await sleep(100);

      // B has a tiny budget → statement_timeout cancels its blocking acquire → it
      // fails open and runs its fn WHILE A still holds the lock.
      let ranWhileHeld = false;
      await withMigrationSerializeLock(
        { databaseUrl: url, lockKey: TEST_LOCK_KEY, budgetMs: 200 },
        () => {
          ranWhileHeld = !events.includes("A:exit");
          events.push("B:ran");
          return Promise.resolve();
        }
      );

      expect(ranWhileHeld).toBe(true);
      expect(events).toContain("B:ran");

      releaseHolder?.();
      await holder;
    });
  }
);
