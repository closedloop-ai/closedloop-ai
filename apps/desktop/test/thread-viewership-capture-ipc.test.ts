/**
 * @file thread-viewership-capture-ipc.test.ts
 * @description ISS-7830 — the PRODUCTION WIRING of the capture, across both
 * boundaries it has to cross.
 *
 * The store's own suite proves the insert is monotonic and the classification
 * suite proves the signal changes the answer. Neither proves the renderer's
 * statement ever REACHES the writer: dropping the `invokeStoreOp` call, or
 * registering the op under a name the child does not resolve, leaves both green
 * while every view is silently discarded. So this drives the REAL registrar
 * through the recording Electron stub and asserts on what actually crossed —
 * including the refusal path, since the id arrives untrusted from the renderer.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { InvokeStoreOp } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { DB_HOST_STORE_OP_PREFIX } from "../src/main/database/db-host/db-host-store-op-registry.js";
import { SESSION_VIEWERSHIP_RECORD_STORE_OP } from "../src/main/database/session-viewership-store.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { THREAD_VIEWED_CHANNEL } from "../src/shared/thread-viewership-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const TRUSTED_EVENT = { sender: {} };
const SESSION_ID = "iss7830-captured-thread";
const CAPTURE_CLOCK = new Date("2026-08-24T10:00:00.000Z");

type StoreOpCall = { name: string; args: unknown[] | undefined };

let mock: ElectronModuleMock;
let registerSessionViewershipIpcHandlers: (deps: {
  withDb: WithDb;
  invokeStoreOp: InvokeStoreOp;
  now?: () => Date;
  isEnabled?: () => boolean;
}) => void;

beforeAll(async () => {
  mock = registerElectronModuleMock();
  // Dynamic, because the redirect must be installed before the registrar
  // evaluates its module-scope `import { ipcMain } from "electron"`.
  const registrar = await import(
    "../src/main/dashboard/agent-dashboard-session-viewership-ipc.js"
  );
  registerSessionViewershipIpcHandlers =
    registrar.registerSessionViewershipIpcHandlers as typeof registerSessionViewershipIpcHandlers;
});

afterAll(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
});

/** A `withDb` that supplies no database: this handler writes through the op. */
const passthroughWithDb: WithDb =
  (handler) =>
  (_event, ...args) =>
    Promise.resolve(handler({} as DbHostAgentDatabase, ...args));

function registerWithRecorder(
  options: { enabled?: boolean; storeAnswer?: unknown; storeError?: Error } = {}
): () => StoreOpCall[] {
  const calls: StoreOpCall[] = [];
  registerSessionViewershipIpcHandlers({
    withDb: passthroughWithDb,
    invokeStoreOp: (name, args) => {
      calls.push({ name, args });
      if (options.storeError) {
        return Promise.reject(options.storeError);
      }
      return Promise.resolve(options.storeAnswer ?? true);
    },
    now: () => CAPTURE_CLOCK,
    isEnabled: () => options.enabled ?? true,
  });
  return () => calls;
}

describe("ISS-7830: the capture channel reaches the writer", () => {
  it("forwards the session id and a stamped instant to the store op", async () => {
    const calls = registerWithRecorder();
    const result = await registeredInvokeHandler(THREAD_VIEWED_CHANNEL)(
      TRUSTED_EVENT,
      SESSION_ID
    );

    assert.deepEqual(calls(), [
      {
        // The prefixed name the db-host dispatcher actually resolves. A bare
        // name is rejected by `dispatchDbHostStoreOp`, and a name no registry
        // entry matches throws there — neither is visible from the store's own
        // suite.
        name: `${DB_HOST_STORE_OP_PREFIX}${SESSION_VIEWERSHIP_RECORD_STORE_OP}`,
        args: [SESSION_ID, CAPTURE_CLOCK.toISOString()],
      },
    ]);
    assert.deepEqual(result, { recorded: true });
  });

  it("refuses a malformed id and says so, rather than reporting it recorded", async () => {
    // IPC is a runtime trust boundary: the handler's annotations do not
    // constrain what a renderer sends. The negative sibling of the case above —
    // without it, a handler that answered `{ recorded: true }` unconditionally
    // and never called the op would still look correct from the first case's
    // perspective only if it also recorded, so this pins BOTH halves: no write,
    // and an honest answer.
    const calls = registerWithRecorder();
    const handler = registeredInvokeHandler(THREAD_VIEWED_CHANNEL);

    for (const malformed of [undefined, null, "", 42, { id: SESSION_ID }]) {
      assert.deepEqual(await handler(TRUSTED_EVENT, malformed), {
        recorded: false,
      });
    }
    assert.deepEqual(calls(), [], "no malformed id may reach the writer");
  });

  it("reports what the writer answered, not that the message was sent", async () => {
    // The store refuses a session this device holds no local row for (the
    // foreign key would otherwise raise SQLITE_CONSTRAINT and reject this
    // handler). A flat `true` here would report that refusal as a delivery.
    const calls = registerWithRecorder({ storeAnswer: false });
    const result = await registeredInvokeHandler(THREAD_VIEWED_CHANNEL)(
      TRUSTED_EVENT,
      SESSION_ID
    );

    assert.equal(calls().length, 1, "the op was still called");
    assert.deepEqual(result, { recorded: false });
  });

  it("propagates the same SQLITE_CONSTRAINT rejection after one canonical store call", async () => {
    const storeError = new Error(
      "SQLITE_CONSTRAINT: session_viewership session_id foreign key"
    );
    storeError.name = "SQLITE_CONSTRAINT";
    const calls = registerWithRecorder({ storeError });

    await assert.rejects(
      () =>
        Promise.resolve(
          registeredInvokeHandler(THREAD_VIEWED_CHANNEL)(
            TRUSTED_EVENT,
            SESSION_ID
          )
        ),
      (error: unknown) => error === storeError
    );
    assert.deepEqual(calls(), [
      {
        name: `${DB_HOST_STORE_OP_PREFIX}${SESSION_VIEWERSHIP_RECORD_STORE_OP}`,
        args: [SESSION_ID, CAPTURE_CLOCK.toISOString()],
      },
    ]);
  });

  it("records nothing while the Labs gate is off", async () => {
    // The gate has to be read HERE, in Electron main: the resolver is a module
    // singleton the composition root registers, and the db-host child has its
    // own module registry — a gate read on that side would be the `false`
    // default forever and the toggle could never turn the feature on.
    const calls = registerWithRecorder({ enabled: false });
    const result = await registeredInvokeHandler(THREAD_VIEWED_CHANNEL)(
      TRUSTED_EVENT,
      SESSION_ID
    );

    assert.deepEqual(calls(), [], "a closed gate must not reach the writer");
    assert.deepEqual(result, { recorded: false });
  });
});
