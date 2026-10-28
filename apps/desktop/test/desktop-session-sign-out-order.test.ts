import assert from "node:assert/strict";
import { test } from "vitest";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { deferred } from "./deferred.js";
import {
  createManager,
  createStubClient,
  installTempRoot,
  storedRecord,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

test("sign out invalidates and publishes before remote revoke settles", async () => {
  const stub = createStubClient();
  const revoke = deferred<{ ok: true; value: true }>();
  stub.client.revoke = () => {
    stub.calls.revoke += 1;
    return revoke.promise;
  };
  const { manager, store } = createManager({
    stub,
    storeName: "iss-10574-sign-out-order",
  });
  store.setSession(storedRecord());
  await manager.restore();
  const before = manager.getAccountAdmission();
  const statuses: string[] = [];
  manager.subscribe((state) => statuses.push(state.status));

  const result = manager.signOut();

  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(manager.getIdentity(), null);
  assert.equal(manager.getAccountAdmission(), null);
  assert.equal(store.hasSession(), false);
  assert.deepEqual(statuses, [DesktopAuthStatus.SignedOut]);
  assert.ok(before);
  assert.equal(stub.calls.revoke, 1);
  await result;

  revoke.resolve({ ok: true, value: true });
});
