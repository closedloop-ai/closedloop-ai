/**
 * @file db-ipc-untrusted-sender-deny.test.ts
 * @description ISS-7894 — the `withDb` sender-trust gate actually DENIES.
 *
 * `withDb` opens with the one check that stops a compromised renderer reaching
 * the database:
 *
 *   if (!options.isTrustedSender(event.sender)) { throw new Error("untrusted sender"); }
 *
 * Every suite that drove the real wrapper passed `isTrustedSender: () => true`
 * (`db-host-exit-consumer-recovery`, `db-host-exit-redrive-wiring`,
 * `db-host-shutdown-cascade`, and `db-host-shutdown-branches-boundary`, whose
 * `mock.fn(() => true)` counts the CALL but never exercises a refusal). Make
 * `isTrustedSender` unconditionally true, or hoist the handler call above the
 * check, and all four stay green while the gate is gone.
 *
 * WHY THE SPY COUNT IS THE ASSERTION AND THE ERROR IS NOT. `withDb` funnels a
 * handler throw and a trust refusal through the same rejection, and its ISS-5262
 * catch can convert a rejection into `DB_HOST_SHUTTING_DOWN_RESULT`. So an
 * assertion on the returned error cannot tell "the guard refused" from "the
 * guard was bypassed and the handler failed". Zero calls on the handler's own
 * spy can, and only the positive sibling — the SAME spy, incremented, one line
 * later — makes that zero mean anything.
 *
 * SCOPE. `desktop:db:get-sessions` is driven through the real production
 * registrar (`registerLocalDashboardReadIpcHandlers`, the same call
 * `registerDesignSystemDbIpcHandlers` makes) rather than through a wrapper built
 * in isolation, because the claim is that PRODUCTION WIRING uses the guard.
 */

import assert from "node:assert/strict";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import type { IpcMainInvokeHandler } from "./helpers/electron-module-stub.js";
import {
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-main-module-stub.js");
  return { ...stub, default: stub.default };
});

/**
 * The channel driven end to end. Its production handler body is
 * `(agentDatabase) => agentDatabase.sessions.getAll()`, so `getAll` below is
 * literally the handler body's only observable act — a call count on it is a
 * direct reading of whether the body ran, not a proxy for one.
 */
const CHANNEL = "desktop:db:get-sessions";

/**
 * Explicit and generous, NOT a raised bound hiding a hang: the setup imports the
 * real registrar's production module graph, which the runner transforms once and
 * which is slow on a loaded machine. Nothing here waits on a timer or a socket.
 */
const SETUP_TIMEOUT_MS = 300_000;

const getAll = vi.fn(() => Promise.resolve([]));
const getAgentDatabase = vi.fn(() =>
  Promise.resolve({ sessions: { getAll } } as unknown as DbHostAgentDatabase)
);

// The stub's own registered-handler type, so what `registeredInvokeHandler`
// returns is assignable without a cast. `IpcHandler`'s `event: unknown` is not:
// under `strictFunctionTypes` a handler that reads `event.sender` cannot be
// widened to one that accepts anything.
let handler: IpcMainInvokeHandler;
let denyAlwaysHandler: IpcMainInvokeHandler;

beforeAll(async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  stub.resetElectronModuleStub();

  const wrappers = await import(
    "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js"
  );
  const registrar = await import(
    "../src/main/dashboard/agent-dashboard-local-read-ipc.js"
  );

  // The production registration pass, with the production wrapper factory. The
  // only doubles are the trust predicate (a real discriminator over sender
  // identity, not a constant) and the database it would have reached.
  registrar.registerLocalDashboardReadIpcHandlers({
    withDb: wrappers.createDbIpcHandlerWrappers({
      getAgentDatabase,
      options: runtimeOptions(isTrustedSenderDouble),
    }).withDb,
    invokeStoreOp: noStoreOp,
  });
  handler = stub.registeredInvokeHandler(CHANNEL);

  // A SECOND production registration pass whose predicate refuses everything,
  // so the AC's literal `isTrustedSender: () => false` case is covered as well
  // as the identity-discriminating one — and covered through the same registrar
  // and the same handler body, not a wrapper hand-built beside it. The stub's
  // handler map overwrites on re-registration, so `handler` above keeps the
  // first pass's function reference and the two remain independent.
  registrar.registerLocalDashboardReadIpcHandlers({
    withDb: wrappers.createDbIpcHandlerWrappers({
      getAgentDatabase,
      options: runtimeOptions(() => false),
    }).withDb,
    invokeStoreOp: noStoreOp,
  });
  denyAlwaysHandler = stub.registeredInvokeHandler(CHANNEL);
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  getAll.mockClear();
  getAgentDatabase.mockClear();
});

describe("ISS-7894: withDb denies an untrusted sender on a real desktop:db channel", () => {
  test(`${CHANNEL} never runs its handler body for an untrusted sender, and does for a trusted one`, async () => {
    await expect(handler(UNTRUSTED_EVENT) as Promise<unknown>).rejects.toThrow(
      UNTRUSTED_SENDER_ERROR
    );

    // THE DISCRIMINATOR. Hoist the handler call above the trust check, or make
    // the predicate unconditionally true, and this is the assertion that fails.
    assert.equal(
      getAll.mock.calls.length,
      0,
      "the handler body ran for an untrusted sender — the gate was bypassed"
    );
    assert.equal(
      getAgentDatabase.mock.calls.length,
      0,
      "the database was resolved for an untrusted sender, before any handler could refuse"
    );

    // The positive sibling, on the SAME spies. Without it the zeros above are
    // equally consistent with a handler that can never be called at all — a
    // broken registration, a wrong channel, a fixture that throws earlier.
    await handler(TRUSTED_EVENT);

    assert.equal(
      getAll.mock.calls.length,
      1,
      "the same handler must run exactly once for a trusted sender"
    );
    assert.equal(getAgentDatabase.mock.calls.length, 1);
  });

  test("a wrapper whose isTrustedSender always refuses denies even a trusted-looking event", async () => {
    // The guard's verdict must come from `isTrustedSender`, not from the shape
    // of the event: this drives the event the case above was ACCEPTED with.
    await expect(
      denyAlwaysHandler(TRUSTED_EVENT) as Promise<unknown>
    ).rejects.toThrow(UNTRUSTED_SENDER_ERROR);

    assert.equal(getAll.mock.calls.length, 0);
    assert.equal(getAgentDatabase.mock.calls.length, 0);
  });
});

function runtimeOptions(
  isTrustedSender: AgentDashboardDesignSystemRuntimeOptions["isTrustedSender"]
): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender,
  } as AgentDashboardDesignSystemRuntimeOptions;
}

/** The sessions channel driven here never reaches a store op. */
function noStoreOp(): Promise<unknown> {
  return Promise.reject(new Error("no store op on this channel"));
}
