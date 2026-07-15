import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApiErrorWatchdog } from "../src/main/database/watchdog.js";

type WatchdogDb = Parameters<typeof createApiErrorWatchdog>[0];

afterEach(() => {
  mock.timers.reset();
});

// The watchdog runs in the main process and takes the proxied agentDatabase
// (FEA-2252): clone-safe `prisma.client.$queryRawUnsafe` reads, and the status
// flip via the clone-safe `markSessionErrored` method (NOT a `prisma.write`
// callback, which can't cross the db-host proxy). This minimal fake drives both
// surfaces; the optional onQuery hook lets a test observe whether any read fired.
function fakeDb(onQuery?: (sql: string) => void): WatchdogDb {
  return {
    prisma: {
      client: {
        $queryRawUnsafe: (sql: string) => {
          onQuery?.(sql);
          return Promise.resolve([]);
        },
      },
    },
    markSessionErrored: () => Promise.resolve(),
  } as unknown as WatchdogDb;
}

const FROM_SESSIONS_RE = /FROM\s+sessions\s+s/;
const API_ERROR_RE = /APIError/;
const LAST_STOP_RE = /event_type = 'Stop'/;

// A SQL-routing fake so a test can stage an active session whose last Stop event
// is stale and carries an error summary, then assert the flip path is taken.
function routingDb(opts: {
  active: { session_id: string; status: string }[];
  recentError?: { one: number }[];
  lastStop?: { created_at: string; summary: string | null }[];
  onMarkErrored: (sessionId: string) => void;
}): WatchdogDb {
  return {
    prisma: {
      client: {
        $queryRawUnsafe: (sql: string) => {
          if (FROM_SESSIONS_RE.test(sql)) {
            return Promise.resolve(opts.active);
          }
          if (API_ERROR_RE.test(sql)) {
            return Promise.resolve(opts.recentError ?? []);
          }
          if (LAST_STOP_RE.test(sql)) {
            return Promise.resolve(opts.lastStop ?? []);
          }
          return Promise.resolve([]);
        },
      },
    },
    markSessionErrored: (sessionId: string) => {
      opts.onMarkErrored(sessionId);
      return Promise.resolve();
    },
  } as unknown as WatchdogDb;
}

test("createApiErrorWatchdog returns start/stop methods", () => {
  const wd = createApiErrorWatchdog(fakeDb());
  assert.equal(typeof wd.start, "function");
  assert.equal(typeof wd.stop, "function");
});

test("createApiErrorWatchdog start/stop does not throw on empty DB", () => {
  const wd = createApiErrorWatchdog(fakeDb());
  wd.start();
  wd.stop();
});

test("createApiErrorWatchdog uses custom poll interval", () => {
  const wd = createApiErrorWatchdog(fakeDb(), { pollMs: 5000 });
  assert.ok(wd);
});

test("createApiErrorWatchdog uses configurable stale event ms", () => {
  const queries: string[] = [];
  const wd = createApiErrorWatchdog(
    fakeDb((sql) => queries.push(sql)),
    {
      staleEventMs: 5000,
      pollMs: 100_000,
    }
  );
  wd.start();
  wd.stop();
  assert.ok(queries.length === 0, "should not query before first poll tick");
});

test("createApiErrorWatchdog flips a stale errored session via markSessionErrored", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const marked: string[] = [];
  const db = routingDb({
    active: [{ session_id: "s1", status: "running" }],
    // A long-past Stop event with an error summary → eligible for the flip.
    lastStop: [
      { created_at: "2000-01-01T00:00:00.000Z", summary: "rate limit error" },
    ],
    onMarkErrored: (id) => marked.push(id),
  });
  const wd = createApiErrorWatchdog(db, { pollMs: 1000, staleEventMs: 1000 });
  wd.start();
  mock.timers.tick(1000);
  // Flush the async check() the interval kicked off.
  await new Promise((resolve) => setImmediate(resolve));
  wd.stop();
  assert.deepEqual(
    marked,
    ["s1"],
    "the stale errored session must be flipped through markSessionErrored"
  );
});
