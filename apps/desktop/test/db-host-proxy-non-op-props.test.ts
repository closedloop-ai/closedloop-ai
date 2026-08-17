/**
 * @file db-host-proxy-non-op-props.test.ts
 * @description Guards the property names the DB-host method proxy must NOT
 * answer with an op path.
 *
 * The proxy's `get` trap turns property access into a dotted op path, so by
 * default it answers EVERY string property — including `Function.prototype`'s
 * own methods. That made the ordinary idiom `db.someOp.bind(db)` silently build
 * the op path `someOp.bind` and invoke it over IPC with the proxy ITSELF as an
 * argument. The proxy is not structured-clone-safe, so `postMessage` threw
 * "An object could not be cloned"; the resulting rejected promise had no
 * `.catch`, so it reached `handleUnhandledRejection`, which shows the crash
 * dialog and calls `app.exit(1)`. Worse, the reported op name (`<op>.bind`)
 * named a DB op that does not exist rather than the caller.
 *
 * That crash shipped twice — ISS-4620 (`syncSource.advanceSyncState.bind`) and
 * again in the ISS-4818 store-integrity probe
 * (`runTokenParityCheck.bind` / `readWalProbeHealth.bind`) — so the trap itself
 * now refuses these names: a detach attempt fails as a plain, local TypeError at
 * the call site with no rejected promise to take the process down.
 *
 * `then`/`catch`/`finally` are the pre-existing members of the same set: a proxy
 * that answers `then` looks thenable, which breaks `await`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import type { DbHostClient } from "../src/main/database/db-host/db-host-client.js";

type InvokeCall = { op: string; args: unknown[] };

function proxyWithRecorder(): {
  agentDatabase: ReturnType<typeof createDbHostAgentDatabase>;
  calls: InvokeCall[];
} {
  const calls: InvokeCall[] = [];
  const client = {
    invoke: (op: string, args: unknown[]) => {
      calls.push({ op, args });
      return Promise.resolve(undefined);
    },
  } as unknown as DbHostClient;
  return { agentDatabase: createDbHostAgentDatabase(client), calls };
}

test("the proxy does not answer Function.prototype detach methods with an op path", () => {
  const { agentDatabase, calls } = proxyWithRecorder();
  const op = agentDatabase.sessions.count as unknown as Record<string, unknown>;

  assert.equal(op.bind, undefined);
  assert.equal(op.call, undefined);
  assert.equal(op.apply, undefined);
  assert.deepEqual(calls, []);
});

test("detaching a proxy method throws locally instead of posting an uncloneable op", () => {
  const { agentDatabase, calls } = proxyWithRecorder();
  const source = agentDatabase.syncSource as unknown as {
    advanceSyncState: { bind: (thisArg: unknown) => unknown };
  };

  // The exact ISS-4620 caller shape. It must now fail HERE, synchronously, and
  // must not have dispatched `syncSource.advanceSyncState.bind` over IPC.
  assert.throws(
    () => source.advanceSyncState.bind(source),
    (error: unknown) => error instanceof TypeError
  );
  assert.deepEqual(calls, []);
});

test("the proxy still answers real op paths and forwards args verbatim", async () => {
  const { agentDatabase, calls } = proxyWithRecorder();

  await agentDatabase.sessions.count();
  await agentDatabase.runTokenParityCheck();

  assert.deepEqual(calls, [
    { op: "sessions.count", args: [] },
    { op: "runTokenParityCheck", args: [] },
  ]);
});

test("the proxy stays non-thenable so awaiting a result does not recurse", async () => {
  const { agentDatabase, calls } = proxyWithRecorder();
  const nested = agentDatabase.sessions as unknown as Record<string, unknown>;

  assert.equal(nested.then, undefined);
  assert.equal(nested.catch, undefined);
  assert.equal(nested.finally, undefined);

  assert.equal(await agentDatabase.sessions.count(), undefined);
  assert.deepEqual(calls, [{ op: "sessions.count", args: [] }]);
});
