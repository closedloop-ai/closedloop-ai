/**
 * @file db-host-unhandled-rejection-guards.test.ts
 * @description ISS-8776 AC1 — no db-host call may reach the process
 * unhandled-rejection handler.
 *
 * The observed crash was `[error-handler] unhandled rejection: db-host exited
 * (code: 1)` with the stack pointing at `DbHostClient.handleExit`. That stack
 * names where the error was MINTED, not where it went unhandled — `handleExit`
 * fans one rejection out to every pending op — so the log cannot identify the
 * guilty call site on its own. What it does establish is the CLASS: a
 * main-process db-host call whose promise had no rejection handler.
 *
 * An audit of `apps/desktop/src/main` found exactly three such call sites, and
 * this suite drives all three. They are guarded with the repo's existing
 * fire-and-forget contract (`dropOnDbHostLifecycleError`), never a bare
 * try/catch: a db-host lifecycle failure is dropped with a log because nothing
 * is waiting on these and the next tick re-reads, while every OTHER rejection
 * is rethrown and stays exactly as loud as it is today. A blanket catch here
 * would trade a crash for a hidden bug.
 *
 * Each case asserts on the guard's own dropped-write log line, which is minted
 * in exactly one place (`describeDroppedDbHostWrite`), so a test cannot pass by
 * observing some unrelated log.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AdminKeyStoreLike } from "../src/main/cost/cost-reconciliation-service.js";
import { CostReconciliationService } from "../src/main/cost/cost-reconciliation-service.js";
import type { MeteredUsageRow } from "../src/main/cost/reconciliation-worker.js";
import { RequiredPluginInstaller } from "../src/main/packs/required-plugin-installer.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";

/** The one wording the fire-and-forget guard mints when it drops a write. */
const DROPPED_RE = /dropped by a db-host lifecycle event/;
/** The distinguishing clause of a rejection that is NOT a lifecycle event. */
const REAL_BUG_MESSAGE = "column agent_packs.nope does not exist";

/** A db-host exit with a replacement already scheduled — the common bounce. */
function dbHostBounce(): DbHostExitError {
  return new DbHostExitError(1, true, "db-host exited (code: 1)");
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    await Promise.resolve();
  }
}

/**
 * Capture rejections that escape to the process handler for the duration of
 * `run`, so a test can assert that NOTHING escaped rather than only that a log
 * line appeared. Node reports these asynchronously, so the caller drains
 * microtasks and a macrotask turn before reading the list.
 */
async function withEscapedRejections(
  run: () => Promise<void>
): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const capture = (reason: unknown): void => {
    escaped.push(reason);
  };
  const priorHandlers = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", capture);
  try {
    await run();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.removeListener("unhandledRejection", capture);
    for (const handler of priorHandlers) {
      process.on(
        "unhandledRejection",
        handler as (reason: unknown, promise: Promise<unknown>) => void
      );
    }
  }
  return escaped;
}

/** An Admin key store fake with a configured key, so a pass actually runs. */
function keyStoreWithKey(vendor: string): AdminKeyStoreLike {
  return {
    getKey: () => "sk-ant-admin-test",
    getStatus: () => ({ vendor, hasKey: true }) as never,
    setKey: () => undefined,
    clearKey: () => undefined,
  };
}

/** An Admin key store fake with no key configured. */
function keyStoreWithoutKey(vendor: string): AdminKeyStoreLike {
  return {
    getKey: () => null,
    getStatus: () => ({ vendor, hasKey: false }) as never,
    setKey: () => undefined,
    clearKey: () => undefined,
  };
}

/**
 * Build the service with an injected interval seam, so a scheduled tick can be
 * fired synchronously. The tick is the production entry point under test — the
 * `void`-launched callback whose rejection had nowhere to go.
 */
function makeScheduledService(
  loadUsageRows: () => Promise<MeteredUsageRow[]>,
  logs: string[]
): { service: CostReconciliationService; fire: () => boolean } {
  let intervalHandler: (() => void) | null = null;
  const service = new CostReconciliationService({
    anthropicKeyStore: keyStoreWithKey("anthropic"),
    openaiKeyStore: keyStoreWithoutKey("openai"),
    store: { upsert: () => 0, list: () => [] },
    loadUsageRows,
    log: (message) => logs.push(message),
    setTimeout: () => 1 as never,
    clearTimeout: () => undefined,
    setInterval: (handler) => {
      intervalHandler = handler;
      return 2 as never;
    },
    clearInterval: () => undefined,
  });
  return {
    service,
    /**
     * Fire the armed interval. Returns false when nothing was armed, so the
     * CASE asserts that (an assertion inside this helper would sit outside a
     * `test()` and is not reliably reported by the runner).
     */
    fire: (): boolean => {
      if (!intervalHandler) {
        return false;
      }
      (intervalHandler as unknown as () => void)();
      return true;
    },
  };
}

test("a db-host bounce under the scheduled cost pass never escapes to the process handler", async () => {
  const logs: string[] = [];
  const scheduled = makeScheduledService(
    () => Promise.reject(dbHostBounce()),
    logs
  );

  let fired = false;
  const escaped = await withEscapedRejections(async () => {
    scheduled.service.start();
    fired = scheduled.fire();
    await settle();
  });

  assert.equal(fired, true, "the scheduled cadence armed an interval");
  assert.deepEqual(
    escaped,
    [],
    "the nightly pass must not take the app down when the store bounces under it"
  );
  assert.ok(
    logs.some((line) => DROPPED_RE.test(line)),
    `the guard reported the dropped pass; saw: ${logs.join(" | ")}`
  );
});

test("a NON-lifecycle failure in the scheduled cost pass is still raised, not swallowed", async () => {
  const logs: string[] = [];
  const scheduled = makeScheduledService(
    () => Promise.reject(new Error(REAL_BUG_MESSAGE)),
    logs
  );

  let fired = false;
  const escaped = await withEscapedRejections(async () => {
    scheduled.service.start();
    fired = scheduled.fire();
    await settle();
  });

  assert.equal(fired, true, "the scheduled cadence armed an interval");
  // The guard narrows the crash to the lifecycle window; it is NOT a blanket
  // catch. A real SQL bug must stay exactly as loud as it was before ISS-8776.
  assert.equal(escaped.length, 1, "the real failure still reached the handler");
  assert.match(String(escaped[0]), new RegExp(REAL_BUG_MESSAGE));
  assert.ok(
    !logs.some((line) => DROPPED_RE.test(line)),
    "a real bug must not be reported as a dropped best-effort write"
  );
});

/** One auto_install distribution, as the assigned-distributions endpoint returns it. */
function assignedDistributionsResponse(): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: [
        {
          id: "dist-1",
          organizationId: "org-1",
          catalogItemId: "item-1",
          catalogItem: {
            id: "item-1",
            targetKind: "plugin",
            name: "example-pack",
            source: "github",
          },
          mode: "auto_install",
          targetingType: "all",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

test("a db-host bounce under the cloud-online plugin reconcile never escapes", async () => {
  let installedVersionCalls = 0;
  const installer = new RequiredPluginInstaller({
    distributionsClient: {
      getAccessToken: () => Promise.resolve("token"),
      getApiOrigin: () => "https://api.example.test",
      fetch: () => Promise.resolve(assignedDistributionsResponse()),
    } as never,
    // The db-host read this path reaches BEFORE any try block:
    // doReconcile → processAutoInstall → getInstalledVersion → packStore.getPack.
    getInstalledVersion: () => {
      installedVersionCalls += 1;
      return Promise.reject(dbHostBounce());
    },
    runInstall: () => Promise.resolve(null),
  });

  const escaped = await withEscapedRejections(async () => {
    installer.reconcileInBackground("target-1");
    await settle();
  });

  assert.equal(
    installedVersionCalls,
    1,
    "the reconcile actually reached the db-host read — otherwise this test proves nothing"
  );
  assert.deepEqual(
    escaped,
    [],
    "a reconnect racing a store bounce must not take the app down"
  );
});
