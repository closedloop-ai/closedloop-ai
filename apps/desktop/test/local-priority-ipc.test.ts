/**
 * @file local-priority-ipc.test.ts
 * @description ISS-10332 / PLN-2086 Milestone 3 step 16 — the PRODUCTION
 * WIRING of the local priority write, across the renderer→main boundary.
 *
 * The store's own suite proves what a write does; none of it proves a
 * renderer's request REACHES the writer, or that a request that must not reach
 * it does not. So this drives the real registrar behind the real `withDb` trust
 * gate through the recording Electron stub, and asserts on what actually crossed
 * to the db-host child and what was pushed back to the renderer.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Priority } from "@repo/api/src/types/common";
import type { BrowserWindow } from "electron";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { createDbIpcHandlerWrappers } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { routeStoreOp } from "../src/main/dashboard/store-op-router.js";
import {
  DB_HOST_STORE_OP_PREFIX,
  dispatchDbHostStoreOp,
} from "../src/main/database/db-host/db-host-store-op-registry.js";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP,
  LOCAL_SESSION_PRIORITY_WRITE_STORE_OP,
} from "../src/main/database/local-priority-store.js";
import {
  type DbHostAgentDatabase,
  openSqliteAgentDatabase,
} from "../src/main/database/sqlite.js";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
  LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
  LocalPriorityWriteStatus,
} from "../src/shared/local-priority-write-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import { fakeWindow, type SendCall } from "./helpers/fake-window.js";
import { makeSession } from "./normalized-session-test-utils.js";

const TRUSTED_SENDER = { id: "trusted-renderer" };
const UNTRUSTED_SENDER = { id: "some-other-frame" };
const WRITE_CLOCK = new Date("2026-09-22T13:00:00.000Z");
const SESSION_ID = "iss10332-ipc-session";
const BRANCH_ID = "owner%2Frepo::feat%2Fx";
const RE_UNTRUSTED_SENDER = /untrusted sender/;
const RE_INVALID_PAYLOAD = /Invalid priority write IPC payload/;

type StoreOpCall = { name: string; args: unknown[] | undefined };

let mock: ElectronModuleMock;
let registerLocalPriorityIpcHandlers: (deps: {
  withDb: ReturnType<typeof createDbIpcHandlerWrappers>["withDb"];
  invokeStoreOp: InvokeStoreOp;
  getWindow: () => BrowserWindow | null;
  now?: () => Date;
}) => void;

beforeAll(async () => {
  mock = registerElectronModuleMock();
  const registrar = await import(
    "../src/main/dashboard/agent-dashboard-local-priority-ipc.js"
  );
  registerLocalPriorityIpcHandlers =
    registrar.registerLocalPriorityIpcHandlers as typeof registerLocalPriorityIpcHandlers;
});

afterAll(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
});

function register(
  storeAnswer: unknown = {
    status: LocalPriorityWriteStatus.Written,
    priority: Priority.High,
  }
): { calls: StoreOpCall[]; sends: SendCall[] } {
  const calls: StoreOpCall[] = [];
  const sends: SendCall[] = [];
  registerWithStoreOp((name, args) => {
    calls.push({ name, args });
    return Promise.resolve(storeAnswer);
  }, sends);
  return { calls, sends };
}

function registerWithStoreOp(
  invokeStoreOp: InvokeStoreOp,
  sends: SendCall[]
): void {
  // The REAL wrapper, so the trust gate under test is the production one.
  const { withDb } = createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve({} as DbHostAgentDatabase),
    options: {
      getWindow: () => null,
      isTrustedSender: (sender) => Object.is(sender, TRUSTED_SENDER),
    } as AgentDashboardDesignSystemRuntimeOptions,
  });
  registerLocalPriorityIpcHandlers({
    withDb,
    invokeStoreOp,
    getWindow: () => fakeWindow({ calls: sends }),
    now: () => WRITE_CLOCK,
  });
}

describe("ISS-10332: the local priority write channels", () => {
  it("forward a valid session request to the store op and nudge the renderer", async () => {
    const { calls, sends } = register();
    const request = {
      id: SESSION_ID,
      priority: Priority.High,
      expectedPriority: null,
    };
    const result = await registeredInvokeHandler(
      LOCAL_SESSION_PRIORITY_WRITE_CHANNEL
    )({ sender: TRUSTED_SENDER }, request);

    assert.deepEqual(calls, [
      {
        name: LOCAL_SESSION_PRIORITY_WRITE_STORE_OP,
        args: [request, WRITE_CLOCK.toISOString()],
      },
    ]);
    assert.deepEqual(result, {
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.High,
    });
    assert.deepEqual(sends, [
      { channel: "desktop:db:changed", args: [{ sessionId: SESSION_ID }] },
    ]);
  });

  it("forward a valid branch request to its own store op", async () => {
    const { calls, sends } = register();
    await registeredInvokeHandler(LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL)(
      { sender: TRUSTED_SENDER },
      { id: BRANCH_ID, priority: null }
    );

    assert.deepEqual(
      calls.map((call) => call.name),
      [LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP]
    );
    assert.deepEqual(sends, [{ channel: "desktop:db:changed", args: [{}] }]);
  });

  it("refuse an untrusted sender before anything reaches the writer", async () => {
    const { calls, sends } = register();
    for (const channel of [
      LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
      LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
    ]) {
      await assert.rejects(
        async () =>
          await registeredInvokeHandler(channel)(
            { sender: UNTRUSTED_SENDER },
            { id: SESSION_ID, priority: Priority.Low }
          ),
        RE_UNTRUSTED_SENDER
      );
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(sends, []);
  });

  it("refuse a malformed or out-of-vocabulary payload before anything reaches the writer", async () => {
    const { calls, sends } = register();
    const handler = registeredInvokeHandler(
      LOCAL_SESSION_PRIORITY_WRITE_CHANNEL
    );
    for (const malformed of [
      undefined,
      null,
      SESSION_ID,
      { id: SESSION_ID },
      { id: "", priority: Priority.Low },
      { id: SESSION_ID, priority: "CRITICAL" },
      { id: SESSION_ID, priority: "low" },
      { id: SESSION_ID, priority: Priority.Low, expectedPriority: "CRITICAL" },
      { id: SESSION_ID, priority: Priority.Low, extra: true },
    ]) {
      await assert.rejects(
        async () => await handler({ sender: TRUSTED_SENDER }, malformed),
        RE_INVALID_PAYLOAD
      );
    }
    assert.deepEqual(calls, [], "no malformed payload may reach the writer");
    assert.deepEqual(sends, []);
  });

  it("push no change for a write the store refused", async () => {
    const { sends } = register({ status: LocalPriorityWriteStatus.Stale });
    const result = await registeredInvokeHandler(
      LOCAL_SESSION_PRIORITY_WRITE_CHANNEL
    )(
      { sender: TRUSTED_SENDER },
      { id: SESSION_ID, priority: Priority.Low, expectedPriority: null }
    );

    assert.deepEqual(result, { status: LocalPriorityWriteStatus.Stale });
    assert.deepEqual(sends, []);
  });

  it("resolve both op names through the production router and db-host registry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss10332-priority-ipc-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
    });
    try {
      await db.importer.importSession(
        makeSession({
          sessionId: SESSION_ID,
          artifacts: { prs: [], issues: [], repo: "owner/repo" },
          toolUses: [
            {
              name: "Bash",
              timestamp: WRITE_CLOCK.toISOString(),
              input: { command: "git push -u origin feat/x" },
            },
          ],
        }),
        "claude"
      );
      const sends: SendCall[] = [];
      // Main's `invokeStoreOp` is `routeStoreOp` over a `rawStoreOp` that
      // prefixes the name and invokes the db-host, which dispatches it here
      // (`agent-dashboard-db-host-lifecycle.ts` forks a real child, so its
      // one-line prefixing closure is restated rather than imported).
      registerWithStoreOp(
        (name, args = []) =>
          routeStoreOp(name, args, {
            packScanCoordinator: null,
            catalogCoordinator: null,
            rawStoreOp: (storeKey, storeArgs = []) =>
              dispatchDbHostStoreOp(
                {},
                db,
                `${DB_HOST_STORE_OP_PREFIX}${storeKey}`,
                storeArgs
              ),
          }),
        sends
      );

      const session = await registeredInvokeHandler(
        LOCAL_SESSION_PRIORITY_WRITE_CHANNEL
      )(
        { sender: TRUSTED_SENDER },
        { id: SESSION_ID, priority: Priority.Urgent }
      );
      const branch = await registeredInvokeHandler(
        LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL
      )({ sender: TRUSTED_SENDER }, { id: BRANCH_ID, priority: Priority.Low });

      assert.deepEqual(session, {
        status: LocalPriorityWriteStatus.Written,
        priority: Priority.Urgent,
      });
      assert.deepEqual(branch, {
        status: LocalPriorityWriteStatus.Written,
        priority: Priority.Low,
      });
      const stored = await db.prisma.client.$queryRawUnsafe<
        { priority: string | null }[]
      >("SELECT priority FROM sessions WHERE id = $1", SESSION_ID);
      assert.deepEqual(stored, [{ priority: Priority.Urgent }]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
