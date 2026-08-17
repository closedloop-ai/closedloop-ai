import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import {
  OrgSyncPolicyStore,
  type OrgSyncPolicyStoreOptions,
} from "../src/main/agent-sync/org-sync-policy-store.js";
import {
  type OrgSyncPolicyAccountIdentity,
  type OrgSyncPolicyLaneKicks,
  wireOrgSyncPolicySubscription,
} from "../src/main/agent-sync/org-sync-policy-subscription.js";
import type { SessionFetchOptions } from "../src/main/util/api-response-utils.js";

const ACCOUNT_A: OrgSyncPolicyAccountIdentity = {
  userId: "u1",
  organizationId: "o1",
};

const ACCOUNT_B: OrgSyncPolicyAccountIdentity = {
  userId: "u2",
  organizationId: "o2",
};

// ISS-4623 (wongk review) — the subscription lifecycle extracted from app.ts.
// These pin the two invariants the extraction owns: it re-kicks the lanes on a
// policy transition, it is disposable, and it NEVER re-kicks a lane once
// shutdown has begun (a refresh resolving during teardown must not restart an
// upload while the cloud socket is still online).

const FETCH_OPTIONS: SessionFetchOptions = {
  getAccessToken: () => Promise.resolve("token"),
  getApiOrigin: () => "https://api.example.test",
};

function makeIdentity(enabled: boolean): DesktopIdentity {
  return {
    userId: "u1",
    organizationId: "o1",
    email: "person@example.test",
    firstName: null,
    lastName: null,
    organizationName: null,
    sessionSyncPolicyEnabled: enabled,
    // ISS-4705: a CURRENT server always advertises policy support alongside the
    // explicit boolean. The boolean short-circuits ahead of the capability check,
    // so this does not change the resolved state — it keeps the fixture faithful
    // to the real response shape these subscription tests stand in for.
    sessionSyncPolicySupported: true,
  };
}

const openStores: OrgSyncPolicyStore[] = [];

/**
 * Build a store and register it for teardown, as in `org-sync-policy.test.ts`.
 * These tests all resolve the policy, so none currently arms the store's
 * self-heal loop — but on the default scheduler that loop is a real `setTimeout`
 * that re-arms itself while the policy stays `"unknown"`, which keeps the
 * node:test child process alive and wedges the whole `test:node` runner rather
 * than failing a test. Taking `dispose()` unconditionally keeps a future
 * unresolved-policy test here from reintroducing that.
 */
function createStore(options: OrgSyncPolicyStoreOptions): OrgSyncPolicyStore {
  const store = new OrgSyncPolicyStore(options);
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores) {
    store.dispose();
  }
  openStores.length = 0;
});

type Counters = {
  laneKicks: OrgSyncPolicyLaneKicks;
  metadata: () => number;
  invocation: () => number;
  sweep: () => number;
};

function makeCounters(): Counters {
  let metadata = 0;
  let invocation = 0;
  let sweep = 0;
  return {
    laneKicks: {
      refreshAgentSessionSync: () => {
        metadata += 1;
      },
      refreshComponentInvocationSync: () => {
        invocation += 1;
      },
      kickTranscriptSweep: () => {
        sweep += 1;
      },
    },
    metadata: () => metadata,
    invocation: () => invocation,
    sweep: () => sweep,
  };
}

test("re-kicks all three lanes on a policy transition", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(makeIdentity(true)),
  });
  const counters = makeCounters();
  wireOrgSyncPolicySubscription({
    store,
    laneKicks: counters.laneKicks,
    isShuttingDown: () => false,
    getAccountIdentity: () => ACCOUNT_A,
  });

  await store.refresh();

  assert.equal(counters.metadata(), 1);
  assert.equal(counters.invocation(), 1);
  assert.equal(counters.sweep(), 1);
});

test("does NOT re-kick any lane once shutdown has begun", async () => {
  let shuttingDown = false;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(makeIdentity(true)),
  });
  const counters = makeCounters();
  wireOrgSyncPolicySubscription({
    store,
    laneKicks: counters.laneKicks,
    isShuttingDown: () => shuttingDown,
    getAccountIdentity: () => ACCOUNT_A,
  });

  // A policy transition that resolves DURING teardown must not restart a lane.
  shuttingDown = true;
  await store.refresh();

  assert.equal(counters.metadata(), 0);
  assert.equal(counters.invocation(), 0);
  assert.equal(counters.sweep(), 0);
});

test("dispose() unsubscribes so a later transition fires into nothing", async () => {
  let response = makeIdentity(true);
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(response),
  });
  const counters = makeCounters();
  const subscription = wireOrgSyncPolicySubscription({
    store,
    laneKicks: counters.laneKicks,
    isShuttingDown: () => false,
    getAccountIdentity: () => ACCOUNT_A,
  });

  await store.refresh();
  assert.equal(counters.metadata(), 1);

  // After disposal a real transition (true → false) must not reach the lanes.
  subscription.dispose();
  response = makeIdentity(false);
  await store.refresh();
  assert.equal(counters.metadata(), 1);
});

test("dispose() is idempotent", () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(makeIdentity(true)),
  });
  const counters = makeCounters();
  const subscription = wireOrgSyncPolicySubscription({
    store,
    laneKicks: counters.laneKicks,
    isShuttingDown: () => false,
    getAccountIdentity: () => ACCOUNT_A,
  });
  subscription.dispose();
  subscription.dispose();
});

test("onAuthSessionChange resets the cached policy then refreshes the new account", async () => {
  let response = makeIdentity(true);
  let currentAccount: OrgSyncPolicyAccountIdentity | null = ACCOUNT_A;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(response),
  });
  const counters = makeCounters();
  const subscription = wireOrgSyncPolicySubscription({
    store,
    laneKicks: counters.laneKicks,
    isShuttingDown: () => false,
    getAccountIdentity: () => currentAccount,
  });

  await store.refresh();
  assert.equal(store.getPolicyState(), true);

  // Genuine account switch (identity A → B) to a policy-off org: the reset must
  // clear the prior `true` (fail-closed `unknown`) before the new account's
  // `false` lands.
  response = makeIdentity(false);
  currentAccount = ACCOUNT_B;
  subscription.onAuthSessionChange();
  // The synchronous reset already dropped the previous account's value.
  assert.equal(store.getPolicyState(), "unknown");
  // Let the kicked refresh settle to the new account's explicit value.
  await store.refresh();
  assert.equal(store.getPolicyState(), false);
});

test("same-account token renewal refreshes WITHOUT resetting the cached policy", async () => {
  // ISS-4623 (shafty023) — `applyTokens` re-notifies subscribers with an
  // UNCHANGED identity on a routine same-account token renewal. With `"unknown"`
  // now fail-closed, a reset there would discard a known `true` and pause every
  // lane until the next identity fetch succeeds; a transient failure would extend
  // that into an outage. So a same-account change must NOT reset.
  let response: DesktopIdentity | null = makeIdentity(true);
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(response),
  });
  const counters = makeCounters();
  const subscription = wireOrgSyncPolicySubscription({
    store,
    laneKicks: counters.laneKicks,
    isShuttingDown: () => false,
    // Identity is unchanged across the renewal.
    getAccountIdentity: () => ACCOUNT_A,
  });

  await store.refresh();
  assert.equal(store.getPolicyState(), true);

  // Simulate a transient identity failure on the renewal's refresh: the cached
  // `true` must survive (no reset to fail-closed `"unknown"`).
  response = null;
  subscription.onAuthSessionChange();
  assert.equal(store.getPolicyState(), true);
  await store.refresh();
  assert.equal(store.getPolicyState(), true);
});

test("onAuthSessionChange no-ops during shutdown", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(makeIdentity(true)),
  });
  await store.refresh();
  assert.equal(store.getPolicyState(), true);

  const counters = makeCounters();
  const subscription = wireOrgSyncPolicySubscription({
    store,
    laneKicks: counters.laneKicks,
    isShuttingDown: () => true,
    getAccountIdentity: () => ACCOUNT_A,
  });

  // During teardown the auth-change reaction must not reset/refresh (which would
  // drop the cached policy and issue a fetch mid-shutdown).
  subscription.onAuthSessionChange();
  assert.equal(store.getPolicyState(), true);
});
