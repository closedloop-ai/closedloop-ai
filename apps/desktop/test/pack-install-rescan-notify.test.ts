/**
 * @file pack-install-rescan-notify.test.ts
 * @description ISS-6882 — the PRODUCTION WIRING of the install/uninstall cache
 * nudge.
 *
 * `AgentComponentsLiveBridge` gives the Agents workspace an invalidation channel,
 * but a bridge nobody notifies changes nothing. On the desktop local scope the
 * component QueryClient runs `staleTime: Infinity` with focus and reconnect
 * refetches off, so `desktop:db:changed` is the ONLY event that can move a cached
 * component query — and the install/uninstall path never emitted one:
 * `streamRun` sends its `complete` IPC BEFORE calling `onComplete`, and
 * `onComplete` fired `packScanner.run()` fire-and-forget. The scenario the ticket
 * exists to fix (install a component, watch the list update) stayed stale until an
 * unrelated DB event or a renderer restart.
 *
 * These cases drive the REAL `ipcMain` registrar through the recording Electron
 * stub and the REAL `streamRun` (which spawns an actual `sh -c` child), then
 * assert on what reached the renderer window. Deleting the notify from either
 * handler fails them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import type {
  WithDb,
  WithPrisma,
} from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  type IpcMainInvokeHandler,
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import { makeCatalogEntry } from "./support/catalog-entry-fixture.js";
import {
  type FakeStreamRunDb,
  makeStreamRunFakeDb,
} from "./support/stream-run-db-fixture.js";

/** The channel every DB-backed renderer cache invalidates on. */
const DB_CHANGED_CHANNEL = "desktop:db:changed";
/** The store op that reconciles the installed-pack inventory against disk. */
const PACK_SCANNER_RUN_OP = "packScanner.run";
const CATALOG_INSTALL_CHANNEL = "desktop:db:catalog-install";
const CATALOG_UNINSTALL_CHANNEL = "desktop:db:catalog-uninstall";
const TRUSTED_EVENT = { sender: {} };
const HARNESS = "claude";
/** `makeCatalogEntry`'s default pack, the one the fake DB row answers for. */
const PACK_ID = "code-review";
/**
 * Explicit bound for the waits below. Each awaits a real child process's `close`
 * handler, so the suite owns a stated timeout rather than leaning on the runner's
 * default to notice a hang.
 */
const SETTLE_TIMEOUT_MS = 30_000;

const tempDirs: string[] = [];

let mock: ElectronModuleMock;
let registerCatalogAndPackIpcHandlers: (deps: {
  withDb: WithDb;
  withPrisma: WithPrisma;
  options: AgentDashboardDesignSystemRuntimeOptions;
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
}) => void;

beforeAll(async () => {
  mock = registerElectronModuleMock();
  // Dynamic, because the redirect must be installed before the registrar
  // evaluates its module-scope `import { app, ipcMain, shell } from "electron"`.
  const registrar = await import(
    "../src/main/dashboard/agent-dashboard-catalog-pack-ipc.js"
  );
  registerCatalogAndPackIpcHandlers =
    registrar.registerCatalogAndPackIpcHandlers as typeof registerCatalogAndPackIpcHandlers;
});

afterAll(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
  resetShellPathCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ISS-6882 — install/uninstall announce the pack rescan", () => {
  test("a completed INSTALL emits desktop:db:changed after the rescan commits", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    const harness = makeHarness();
    const started = await invokeCatalogHandler(
      harness,
      CATALOG_INSTALL_CHANNEL
    );

    assert.equal(started.started, true, "the install run must actually start");
    // Nothing has been announced yet: `streamRun` already sent its `complete`
    // IPC, which is exactly the pre-fix moment the renderer refetched at.
    await harness.rescanSettled;

    assert.deepEqual(harness.dbChangedSends(), [DB_CHANGED_CHANNEL]);
    // Order is the whole point: announcing BEFORE the rescan commits would
    // refetch the same pre-scan inventory and report an install that has not
    // landed. `packScanner.run` resolves only after its writes commit.
    assert.deepEqual(harness.eventLog(), [
      `resolved:${PACK_SCANNER_RUN_OP}`,
      `sent:${DB_CHANGED_CHANNEL}`,
    ]);
  });

  test("a completed UNINSTALL emits desktop:db:changed after the rescan commits", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    const harness = makeHarness();
    const started = await invokeCatalogHandler(
      harness,
      CATALOG_UNINSTALL_CHANNEL
    );

    assert.equal(
      started.started,
      true,
      "the uninstall run must actually start"
    );
    await harness.rescanSettled;

    assert.deepEqual(harness.dbChangedSends(), [DB_CHANGED_CHANNEL]);
  });

  test("a FAILED rescan announces nothing", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    // The counterfactual for the ordering assertion above. A rescan that threw
    // left the inventory pre-scan, so invalidating the renderer's caches would
    // refetch the same stale rows while reporting a completed install — the UI
    // lying about state. The emit is gated on the rescan RESOLVING, not on
    // `onComplete` having run.
    const harness = makeHarness({
      rescan: () => Promise.reject(new Error("db-host unavailable")),
    });
    const started = await invokeCatalogHandler(
      harness,
      CATALOG_INSTALL_CHANNEL
    );

    assert.equal(started.started, true);
    await harness.rescanSettled;

    assert.deepEqual(harness.dbChangedSends(), []);
    // …and the failure does not escape into the handler, which has no error
    // path: `onComplete` is called from `child.on("close")`.
    assert.deepEqual(harness.eventLog(), [`rejected:${PACK_SCANNER_RUN_OP}`]);
  });

  test("the rescan runs on the DB host, not in main", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    // FEA-2038's split, still intact: main spawns and streams the CLI, the DB
    // host owns the scan's writes. A rescan re-homed into main would take the
    // filesystem walk onto the renderer's read path.
    const harness = makeHarness();

    await invokeCatalogHandler(harness, CATALOG_INSTALL_CHANNEL);
    await harness.rescanSettled;

    assert.deepEqual(harness.storeOps(), [PACK_SCANNER_RUN_OP]);
  });
});

type CatalogHandlerResult = { started: boolean };

type Harness = {
  db: FakeStreamRunDb;
  binDir: string;
  eventLog: () => string[];
  rescanSettled: Promise<void>;
  dbChangedSends: () => string[];
  storeOps: () => string[];
};

/**
 * Register the real pack-IPC handlers against a recording window, a recording
 * store-op invoker, and a `streamRun` double whose install/uninstall command is
 * a trivially successful `true`.
 *
 * `rescanSettled` resolves once the rescan promise has settled EITHER way, so a
 * case can await the point at which the emit has happened or provably has not —
 * rather than sleeping to prove a non-occurrence.
 */
function makeHarness(
  overrides: { rescan?: () => Promise<unknown> } = {}
): Harness {
  const events: string[] = [];
  const sent: string[] = [];
  const ops: string[] = [];
  let markSettled = (): void => undefined;
  const rescanSettled = new Promise<void>((resolve) => {
    markSettled = () => resolve();
  });

  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => false },
      send: (channel: string) => {
        sent.push(channel);
        // Only the cache nudge is this suite's subject. `streamRun` also streams
        // its own run-output/complete frames down this same window, and those are
        // covered by the orchestrator suite; logging them here would make the
        // ordering assertion a transcript of an unrelated contract.
        if (channel === DB_CHANGED_CHANNEL) {
          events.push(`sent:${channel}`);
        }
      },
    },
  };

  const invokeStoreOp = (name: string): Promise<unknown> => {
    ops.push(name);
    const run = overrides.rescan?.() ?? Promise.resolve({ scanned: 0 });
    return run.then(
      (value) => {
        events.push(`resolved:${name}`);
        // Settle on a microtask AFTER the production `.then` chain has run, so
        // the emit (if any) is already recorded when the awaiting case resumes.
        queueMicrotask(markSettled);
        return value;
      },
      (error: unknown) => {
        events.push(`rejected:${name}`);
        queueMicrotask(markSettled);
        throw error;
      }
    );
  };

  const entry = makeCatalogEntry({
    installCommands: { claude: "true" },
    uninstallCommands: { claude: "true" },
  });
  const db = makeStreamRunFakeDb(entry);

  const withDb = ((handler: (...args: unknown[]) => unknown) =>
    (_event: unknown, ...args: unknown[]) =>
      Promise.resolve(handler(db, ...args))) as unknown as WithDb;
  const withPrisma = ((handler: (...args: unknown[]) => unknown) =>
    (_event: unknown, ...args: unknown[]) =>
      Promise.resolve(handler(db.prisma, ...args))) as unknown as WithPrisma;

  registerCatalogAndPackIpcHandlers({
    invokeStoreOp,
    options: {
      getWindow: () => window,
    } as unknown as AgentDashboardDesignSystemRuntimeOptions,
    withDb,
    withPrisma,
  });

  return {
    binDir: makeBinDir([HARNESS]),
    db,
    eventLog: () => [...events],
    rescanSettled,
    dbChangedSends: () =>
      sent.filter((channel) => channel === DB_CHANGED_CHANNEL),
    storeOps: () => [...ops],
  };
}

/** Invoke a registered catalog channel with the shell PATH pinned runnable. */
function invokeCatalogHandler(
  harness: Harness,
  channel: string
): Promise<CatalogHandlerResult> {
  const handler: IpcMainInvokeHandler = registeredInvokeHandler(channel);
  return withRunnablePath(
    harness.binDir,
    () =>
      Promise.resolve(
        handler(TRUSTED_EVENT, PACK_ID, HARNESS)
      ) as Promise<CatalogHandlerResult>
  );
}

/**
 * Pin the resolved shell PATH to `binDir` PLUS the real system directories.
 * `streamRun` resolves the child PATH through `getShellPathSync()`, not
 * `process.env.PATH`, and pinning it to the harness stubs alone leaves `sh`
 * itself unresolvable — the child never spawns and the command never runs.
 */
function withRunnablePath<T>(binDir: string, fn: () => T): T {
  const systemPath = process.env.PATH ?? "";
  return withShellPathEnvForTest(
    { ...process.env, PATH: systemPath ? `${binDir}:${systemPath}` : binDir },
    () => {
      setShellPathForTest();
      return fn();
    }
  );
}

/** A directory holding executable stubs for the named harness CLIs. */
function makeBinDir(binaries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-rescan-notify-bin-"));
  tempDirs.push(dir);
  for (const name of binaries) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// ISS-8143 — the catalog mutations' argument guards.
//
// `catalog-install` and `catalog-uninstall` return a bare `{ started: false }`
// for a non-string `packId` or `harness`, and nine sibling `typeof x !== "string"`
// refusals in the same registrar returned their own empty values. None of them
// was executed by any test, so deleting a guard let a renderer-supplied number
// through to `streamRun` — a CLI SPAWN — with nothing red.
//
// The load-bearing assertion is `startedCommands`: an empty array means no
// child process was launched, which a check on the returned value alone cannot
// establish.
//
// PINNED AS-IS, NOT ASSERTED CORRECT: `{ started: false }` carries no `error`,
// while the DISABLED responder for the SAME channel answers
// `{ started:false, error:{ code:"AGENT_DASHBOARD_DISABLED", message } }`.
// `CatalogMutationResult.error` is optional so both compile, but the renderer
// gets a refusal it cannot explain and cannot tell apart from a disabled
// runtime. Adding a reason is a contract change and is deliberately NOT made
// here.
// ---------------------------------------------------------------------------

describe("ISS-8143 — the catalog mutations refuse a malformed argument pair", () => {
  for (const channel of [CATALOG_INSTALL_CHANNEL, CATALOG_UNINSTALL_CHANNEL]) {
    for (const [packId, harnessArg] of [
      [42, HARNESS],
      [PACK_ID, undefined],
      [PACK_ID, 7],
      [null, null],
      [{ packId: PACK_ID }, HARNESS],
    ]) {
      test(`${channel} refuses (${JSON.stringify(packId)}, ${JSON.stringify(harnessArg)}) with no spawn`, async () => {
        const harness = makeHarness();

        const result = (await registeredInvokeHandler(channel)(
          TRUSTED_EVENT,
          packId,
          harnessArg
        )) as CatalogHandlerResult;

        assert.deepEqual(result, { started: false });
        assert.deepEqual(
          harness.db.startedCommands,
          [],
          "a refused mutation must never reach streamRun, so no CLI is spawned"
        );
        assert.deepEqual(harness.storeOps(), []);
      });
    }
  }
});

describe("ISS-8143 — the catalog and plan reads refuse a non-string id", () => {
  // The sibling `typeof x !== "string"` refusals in the same registrar. Each
  // returns its own empty value, and none was executed anywhere.
  //
  // These register their OWN recording prisma rather than reusing `makeHarness`,
  // because the returned empty value is NOT enough to pin the guard: the
  // stream-run fake answers `null` / `[]` for these reads anyway, so a case
  // asserting only the result stays green with the guard deleted while the
  // malformed id reaches the database. The READ COUNT is the load-bearing half.
  /**
   * A prisma double that records EVERY surface it is touched through, as a
   * proxy rather than a fixed shape — these six channels reach four different
   * delegates plus raw SQL, and a hand-listed fake would silently answer
   * `undefined` for the one it forgot (which is how the first draft of the
   * positive control below went red).
   */
  function registerWithRecordingPrisma(): { reads: () => string[] } {
    const reads: string[] = [];
    const rawNames = new Set(["$queryRawUnsafe", "$queryRaw", "$executeRaw"]);
    const client = new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        const model = String(prop);
        if (model === "then") {
          return undefined;
        }
        if (rawNames.has(model)) {
          return (..._args: unknown[]) => {
            reads.push(model);
            return Promise.resolve([]);
          };
        }
        return new Proxy({} as Record<string, unknown>, {
          get(_t, methodProp) {
            const method = String(methodProp);
            return (..._args: unknown[]) => {
              reads.push(`${model}.${method}`);
              return Promise.resolve(method.startsWith("findMany") ? [] : null);
            };
          },
        });
      },
    });
    const prisma = { client };
    const withPrisma = ((handler: (...args: unknown[]) => unknown) =>
      async (_event: unknown, ...args: unknown[]) =>
        await handler(prisma, ...args)) as unknown as WithPrisma;
    const withDb = ((handler: (...args: unknown[]) => unknown) =>
      async (_event: unknown, ...args: unknown[]) =>
        await handler(undefined, ...args)) as unknown as WithDb;

    registerCatalogAndPackIpcHandlers({
      withDb,
      withPrisma,
      options: {} as unknown as AgentDashboardDesignSystemRuntimeOptions,
      invokeStoreOp: (name: string) => {
        reads.push(name);
        return Promise.resolve(undefined);
      },
    });
    return { reads: () => reads };
  }

  const CASES = [
    { channel: "desktop:db:get-catalog-entry", empty: null },
    { channel: "desktop:db:get-catalog-contents", empty: null },
    { channel: "desktop:db:get-catalog-history", empty: [] },
    { channel: "desktop:db:get-plan", empty: null },
    { channel: "desktop:db:get-plan-versions", empty: [] },
  ];

  for (const { channel, empty } of CASES) {
    test(`${channel} refuses a non-string id BEFORE any read`, async () => {
      const { reads } = registerWithRecordingPrisma();

      const result = await registeredInvokeHandler(channel)(TRUSTED_EVENT, 42);

      assert.deepEqual(result, empty);
      assert.deepEqual(
        reads(),
        [],
        "the guard must return before the store is touched"
      );
    });
  }

  test("a well-formed id DOES reach the store on every one of them", async () => {
    // The positive control for the six above. Without it each is satisfied by a
    // handler that reads nothing ever, which is the same false green one layer
    // over.
    for (const { channel } of CASES) {
      const { reads } = registerWithRecordingPrisma();

      await registeredInvokeHandler(channel)(TRUSTED_EVENT, PACK_ID);

      assert.ok(
        reads().length > 0,
        `${channel} must reach the store for a well-formed id`
      );
      resetElectronModuleStub();
    }
  });

  for (const channel of ["desktop:db:confirm-plan", "desktop:db:reject-plan"]) {
    test(`${channel} makes no store write for a non-string id`, async () => {
      const { reads } = registerWithRecordingPrisma();

      const result = await registeredInvokeHandler(channel)(TRUSTED_EVENT, 42);

      assert.equal(result, undefined);
      assert.deepEqual(reads(), []);
    });

    test(`${channel} DOES write for a well-formed id`, async () => {
      const { reads } = registerWithRecordingPrisma();

      await registeredInvokeHandler(channel)(TRUSTED_EVENT, "plan-1");

      assert.deepEqual(reads(), [
        channel.endsWith("confirm-plan") ? "plans.confirm" : "plans.reject",
      ]);
    });
  }
});
