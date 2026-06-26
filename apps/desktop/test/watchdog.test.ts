import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { createApiErrorWatchdog } from "../src/main/database/watchdog.js";

// FEA-1791: the watchdog now takes a DesktopPrisma — reads run on
// `prisma.client.$queryRawUnsafe` (returning rows directly) and the status
// flips go through `prisma.write`. This minimal fake drives both surfaces; the
// optional onQuery hook lets a test observe whether any read fired.
function fakePrisma(onQuery?: (sql: string) => void): DesktopPrisma {
  return {
    client: {
      $queryRawUnsafe: (sql: string) => {
        onQuery?.(sql);
        return Promise.resolve([]);
      },
    },
    write: (fn: (client: unknown) => unknown) =>
      fn({
        $executeRawUnsafe: () => Promise.resolve(0),
        $transaction: (cb: (tx: unknown) => unknown) =>
          cb({ $executeRawUnsafe: () => Promise.resolve(0) }),
      }),
    disconnect: () => Promise.resolve(),
  } as unknown as DesktopPrisma;
}

test("createApiErrorWatchdog returns start/stop methods", () => {
  const wd = createApiErrorWatchdog(fakePrisma());
  assert.equal(typeof wd.start, "function");
  assert.equal(typeof wd.stop, "function");
});

test("createApiErrorWatchdog start/stop does not throw on empty DB", () => {
  const wd = createApiErrorWatchdog(fakePrisma());
  wd.start();
  wd.stop();
});

test("createApiErrorWatchdog uses custom poll interval", () => {
  const wd = createApiErrorWatchdog(fakePrisma(), { pollMs: 5000 });
  assert.ok(wd);
});

test("createApiErrorWatchdog uses configurable stale event ms", () => {
  const queries: string[] = [];
  const wd = createApiErrorWatchdog(
    fakePrisma((sql) => queries.push(sql)),
    {
      staleEventMs: 5000,
      pollMs: 100_000,
    }
  );
  wd.start();
  wd.stop();
  assert.ok(queries.length === 0, "should not query before first poll tick");
});
