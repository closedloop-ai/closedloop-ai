import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DesktopSessionResult,
  DesktopSessionTokens,
} from "../src/main/session/desktop-session-client.js";
import {
  DesktopAuthStatus,
  type DesktopExistingUserResolution,
} from "../src/shared/contracts.js";
import { deferred } from "./deferred.js";
import {
  ACCESS_TTL_MS,
  createExistingUserStub,
  createManager,
  createStubClient,
  installTempRoot,
  makeTokens,
  storedRecord,
  T0,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

test("restore with no stored session becomes signed out", async () => {
  const { manager } = createManager({ storeName: "dsm-none" });
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(manager.getIdentity(), null);
});

test("restore refreshes a stored session and becomes authenticated", async () => {
  const stub = createStubClient();
  stub.setRefresh({
    ok: true,
    value: makeTokens({ refreshToken: "rotated-refresh" }),
  });
  const { manager, store } = createManager({ stub, storeName: "dsm-restore" });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.deepEqual(manager.getIdentity(), {
    userId: "user-1",
    organizationId: "org-1",
  });
  assert.equal(await manager.getAccessToken(), "access-1");
  // The rotated refresh token was persisted.
  assert.equal(store.getSession()?.refreshToken, "rotated-refresh");
});

test("restore clears credentials on a non-retryable refresh failure", async () => {
  const stub = createStubClient();
  stub.setRefresh({ ok: false, error: "invalid", retryable: false });
  const { manager, store } = createManager({ stub, storeName: "dsm-invalid" });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.RefreshFailed);
  assert.equal(manager.getIdentity(), null);
  assert.equal(store.hasSession(), false, "invalid session must be cleared");
});

test("restore preserves credentials on a retryable network failure", async () => {
  const stub = createStubClient();
  stub.setRefresh({ ok: false, error: "network", retryable: true });
  const { manager, store } = createManager({ stub, storeName: "dsm-network" });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.equal(store.hasSession(), true, "credentials preserved for retry");
});

test("getAccessToken serves the cached token within the expiry skew", async () => {
  const stub = createStubClient();
  let nowMs = T0;
  const { manager, store } = createManager({
    stub,
    now: () => nowMs,
    storeName: "dsm-cache",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(stub.calls.refresh, 1);

  // 5 minutes in, still well before the 15-minute expiry minus 60s skew.
  nowMs = T0 + 5 * 60 * 1000;
  assert.equal(await manager.getAccessToken(), "access-1");
  assert.equal(stub.calls.refresh, 1, "no extra refresh while token is fresh");
});

test("FEA-3425: invalidateAccessToken forces a refresh on the next getAccessToken", async () => {
  const stub = createStubClient();
  let nowMs = T0;
  const { manager, store } = createManager({
    stub,
    now: () => nowMs,
    storeName: "dsm-invalidate",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(stub.calls.refresh, 1);

  // Still well inside the token's TTL — a plain read would serve the cache.
  nowMs = T0 + 5 * 60 * 1000;
  stub.setRefresh({ ok: true, value: makeTokens({ accessToken: "access-2" }) });

  // A server 401 reported the cached (unexpired) token as revoked.
  manager.invalidateAccessToken();
  assert.equal(
    manager.getState().status,
    DesktopAuthStatus.Authenticated,
    "invalidation drops the cached token, never the auth state"
  );

  assert.equal(await manager.getAccessToken(), "access-2");
  assert.equal(
    stub.calls.refresh,
    2,
    "next read refreshes instead of re-serving the revoked token"
  );
});

test("getAccessToken refreshes once when concurrent calls race past expiry", async () => {
  const stub = createStubClient();
  let nowMs = T0;
  const { manager, store } = createManager({
    stub,
    now: () => nowMs,
    storeName: "dsm-single-flight",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(stub.calls.refresh, 1);

  // Past expiry — the cached token is stale.
  nowMs = T0 + ACCESS_TTL_MS + 1000;

  const gate = deferred<DesktopSessionResult<DesktopSessionTokens>>();
  stub.setRefresh(() => gate.promise);

  const first = manager.getAccessToken();
  const second = manager.getAccessToken();
  // Both callers should be coalesced into a single in-flight refresh.
  assert.equal(
    stub.calls.refresh,
    2,
    "one additional refresh for both callers"
  );

  gate.resolve({ ok: true, value: makeTokens({ accessToken: "access-2" }) });
  assert.equal(await first, "access-2");
  assert.equal(await second, "access-2");
});

test("signOut revokes the session and clears credentials", async () => {
  const stub = createStubClient();
  const { manager, store } = createManager({ stub, storeName: "dsm-signout" });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  await manager.signOut();

  assert.equal(stub.calls.revoke, 1);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(store.hasSession(), false);
  assert.equal(await manager.getAccessToken(), null);
});

test("sign-out during an in-flight refresh is not overwritten by the resolving refresh", async () => {
  const stub = createStubClient();
  let nowMs = T0;
  const { manager, store } = createManager({
    stub,
    now: () => nowMs,
    storeName: "dsm-signout-race",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  // Past expiry: the next getAccessToken starts a fresh refresh, which we gate.
  nowMs = T0 + ACCESS_TTL_MS + 1000;
  const gate = deferred<DesktopSessionResult<DesktopSessionTokens>>();
  stub.setRefresh(() => gate.promise);

  const tokenPromise = manager.getAccessToken();
  assert.equal(stub.calls.refresh, 2, "a refresh is in flight");

  // Sign out while that refresh is still in flight; revoke resolves first.
  await manager.signOut();
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);

  // The refresh now resolves with valid tokens — it must NOT re-authenticate
  // the signed-out user or write credentials back to disk.
  gate.resolve({ ok: true, value: makeTokens({ refreshToken: "rotated" }) });
  assert.equal(await tokenPromise, null);

  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(manager.getIdentity(), null);
  assert.equal(
    store.hasSession(),
    false,
    "no credentials persisted after sign-out"
  );
});

test("subscribe is notified on state transitions", async () => {
  const stub = createStubClient();
  const { manager, store } = createManager({
    stub,
    storeName: "dsm-subscribe",
  });
  store.setSession(storedRecord());
  const statuses: string[] = [];
  manager.subscribe((state) => statuses.push(state.status));

  await manager.restore(); // stored session refreshes -> authenticated
  await manager.signOut(); // revoke + clear -> signed out

  assert.deepEqual(statuses, [
    DesktopAuthStatus.Authenticated,
    DesktopAuthStatus.SignedOut,
  ]);
});

// --- Existing-user resolution (PRD-532 §8 / M6) ---------------------------

test("existing user with an API key + no session surfaces the prompt", async () => {
  const existing = createExistingUserStub({ hasApiKey: true });
  const { manager } = createManager({
    storeName: "dsm-eur-prompt",
    existingUser: existing.deps,
  });

  await manager.restore(); // no stored session -> signed_out

  assert.deepEqual(manager.getExistingUserResolution(), {
    kind: "prompt",
    dismissed: false,
  });
});

test("no prompt when there is no API key", async () => {
  const existing = createExistingUserStub({ hasApiKey: false });
  const { manager } = createManager({
    storeName: "dsm-eur-nokey",
    existingUser: existing.deps,
  });

  await manager.restore();

  assert.equal(manager.getExistingUserResolution().kind, "none");
});

test("refreshExistingUserResolution re-derives + re-emits after an out-of-band key change", async () => {
  const existing = createExistingUserStub({ hasApiKey: false });
  const { manager } = createManager({
    storeName: "dsm-eur-refresh",
    existingUser: existing.deps,
  });

  await manager.restore(); // signed_out, no key -> none

  const emitted: DesktopExistingUserResolution[] = [];
  manager.subscribeExistingUserResolution((r) => emitted.push(r));
  assert.equal(manager.getExistingUserResolution().kind, "none");

  // Simulate an api-key mutation path (desktop:set-api-key etc.) setting a key
  // without any auth transition, then calling the refresh hook.
  existing.state.hasApiKey = true;
  manager.refreshExistingUserResolution();

  assert.equal(manager.getExistingUserResolution().kind, "prompt");
  assert.deepEqual(emitted, [{ kind: "prompt", dismissed: false }]);

  // Clearing the key + refresh settles back to none and re-emits.
  existing.state.hasApiKey = false;
  manager.refreshExistingUserResolution();
  assert.equal(manager.getExistingUserResolution().kind, "none");
  assert.equal(emitted.at(-1)?.kind, "none");
});

test("no prompt while authenticated (local data + settings untouched)", async () => {
  const stub = createStubClient();
  const existing = createExistingUserStub({ hasApiKey: true });
  const { manager, store } = createManager({
    stub,
    storeName: "dsm-eur-authed",
    existingUser: existing.deps,
  });
  store.setSession(storedRecord());

  await manager.restore(); // stored session refreshes -> authenticated

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.equal(manager.getExistingUserResolution().kind, "none");
  // Data-preservation: the persisted session/settings record is intact and the
  // dismissal was never touched by resolution.
  assert.equal(store.getSession()?.userId, "user-1");
  assert.equal(existing.state.persistCalls, 0);
});

test("dismiss persists and clears the prompt one-time", async () => {
  const existing = createExistingUserStub({ hasApiKey: true });
  const { manager } = createManager({
    storeName: "dsm-eur-dismiss",
    existingUser: existing.deps,
  });
  await manager.restore();
  assert.equal(manager.getExistingUserResolution().kind, "prompt");

  const seen: string[] = [];
  manager.subscribeExistingUserResolution((r) => seen.push(r.kind));
  manager.dismissExistingUserPrompt();

  assert.equal(existing.state.persistCalls, 1, "dismissal is persisted");
  assert.deepEqual(manager.getExistingUserResolution(), {
    kind: "none",
    dismissed: true,
  });
  assert.deepEqual(seen, ["none"], "subscribers see the prompt clear");
});

test("an already-dismissed prompt never reappears", async () => {
  const existing = createExistingUserStub({ hasApiKey: true, dismissed: true });
  const { manager } = createManager({
    storeName: "dsm-eur-predismissed",
    existingUser: existing.deps,
  });

  await manager.restore();

  assert.deepEqual(manager.getExistingUserResolution(), {
    kind: "none",
    dismissed: true,
  });
});

test("an API key alone never mints a session — it only offers the prompt", async () => {
  const existing = createExistingUserStub({ hasApiKey: true });
  const { manager, store } = createManager({
    storeName: "dsm-eur-no-auto-mint",
    existingUser: existing.deps,
  });

  await manager.restore(); // no stored session -> signed_out, key present
  // Drain the microtasks any background mint would have resolved on.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(store.hasSession(), false, "no session was minted from the key");
  assert.equal(await manager.getAccessToken(), null);
  assert.equal(manager.getExistingUserResolution().kind, "prompt");
});

test("sign-out stays signed out while an API key is still present", async () => {
  const stub = createStubClient();
  const existing = createExistingUserStub({ hasApiKey: true });
  const { manager, store } = createManager({
    stub,
    storeName: "dsm-eur-signout-sticks",
    existingUser: existing.deps,
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  await manager.signOut();
  await Promise.resolve();
  await Promise.resolve();

  // The API key outlives the session and cannot be cleared (it may come from an
  // environment variable). Sign-out must not be undone by its presence.
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(store.hasSession(), false);
  assert.equal(await manager.getAccessToken(), null);
  assert.equal(manager.getExistingUserResolution().kind, "prompt");
});

test("sign-out survives a relaunch with an API key still present", async () => {
  const storeName = "dsm-eur-signout-relaunch";
  const first = createManager({
    storeName,
    existingUser: createExistingUserStub({ hasApiKey: true }).deps,
  });
  first.store.setSession(storedRecord());
  await first.manager.restore();
  await first.manager.signOut();

  // A second manager over the same persisted store models the next app launch.
  const relaunched = createManager({
    storeName,
    existingUser: createExistingUserStub({ hasApiKey: true }).deps,
  });
  await relaunched.manager.restore();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    relaunched.manager.getState().status,
    DesktopAuthStatus.SignedOut
  );
  assert.equal(relaunched.store.hasSession(), false);
});

test("existing-user resolution is inert when the ports are absent", async () => {
  const { manager } = createManager({ storeName: "dsm-eur-off" });

  await manager.restore();

  // Flag/feature off (no ports): resolution stays the default `none` and never
  // blocks — today's behavior unchanged.
  assert.deepEqual(manager.getExistingUserResolution(), {
    kind: "none",
    dismissed: false,
  });
});
