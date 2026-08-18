/**
 * @file dashboard-list-window-ipc.test.ts
 * @description ISS-5631 / ISS-6451 — the PRODUCTION WIRING of the paged
 * dashboard windows.
 *
 * `dashboard-plans-window.test.ts` and `dashboard-pull-requests-window.test.ts`
 * prove each query CLAMPS the window it is handed. Neither proves the renderer's
 * window ever REACHES the query: deleting the `opts` argument from either
 * `ipcMain.handle` registration leaves both of those suites green while the
 * channel silently serves page 1 forever.
 *
 * So this drives the REAL registrar through the recording Electron stub and
 * asserts on the argument the store method actually received — including the
 * degrade path, since the payload arrives untrusted from the renderer.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const TRUSTED_EVENT = { sender: {} };

let mock: ElectronModuleMock;
let registerLocalDashboardReadIpcHandlers: (deps: { withDb: WithDb }) => void;

before(async () => {
  mock = registerElectronModuleMock();
  // Dynamic, because the redirect must be installed before the registrar
  // evaluates its module-scope `import { ipcMain } from "electron"`.
  const local = await import(
    "../src/main/dashboard/agent-dashboard-local-read-ipc.js"
  );
  registerLocalDashboardReadIpcHandlers =
    local.registerLocalDashboardReadIpcHandlers as typeof registerLocalDashboardReadIpcHandlers;
});

after(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
});

/**
 * A `withDb` over a recording `dashboard` surface: every windowed read stores
 * the argument it was called with, so the assertion is on what CROSSED the
 * boundary rather than on the handler having run.
 */
function makeRecordingWithDb(): {
  withDb: WithDb;
  received: () => unknown[];
} {
  const received: unknown[] = [];
  const record = (opts: unknown) => {
    received.push(opts);
    return Promise.resolve([]);
  };
  const agentDatabase = {
    dashboard: { getPlans: record, getPullRequests: record },
  } as unknown as DbHostAgentDatabase;
  const withDb: WithDb =
    (handler) =>
    (_event, ...args) =>
      Promise.resolve(handler(agentDatabase, ...args));
  return { withDb, received: () => received };
}

describe("the paged dashboard channels forward the renderer's window", () => {
  for (const channel of [
    "desktop:db:get-plans",
    "desktop:db:get-pull-requests",
  ]) {
    it(`${channel} passes limit/offset through to the store`, async () => {
      const { withDb, received } = makeRecordingWithDb();
      registerLocalDashboardReadIpcHandlers({ withDb });

      await registeredInvokeHandler(channel)(TRUSTED_EVENT, {
        limit: 5,
        offset: 10,
      });

      assert.deepEqual(received(), [{ limit: 5, offset: 10 }]);
    });

    it(`${channel} degrades a non-numeric window to the default`, async () => {
      const { withDb, received } = makeRecordingWithDb();
      registerLocalDashboardReadIpcHandlers({ withDb });

      // A version-skewed or hostile renderer: the bounds are not numbers, and
      // the second call sends no payload at all. Both must reach the store as
      // `undefined` (its "use the default window" reading), never as the raw
      // value — a string `limit` would otherwise flow into the SQL bound.
      await registeredInvokeHandler(channel)(TRUSTED_EVENT, {
        limit: "100000",
        offset: null,
      });
      await registeredInvokeHandler(channel)(TRUSTED_EVENT);

      assert.deepEqual(received(), [
        { limit: undefined, offset: undefined },
        { limit: undefined, offset: undefined },
      ]);
    });
  }
});
