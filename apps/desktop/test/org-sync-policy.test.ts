import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import {
  OrgSyncPolicyStore,
  type OrgSyncPolicyStoreOptions,
  type TimerHandle,
  UNRESOLVED_REFRESH_MIN_INTERVAL_MS,
  UNRESOLVED_SELF_HEAL_INTERVAL_MS,
} from "../src/main/agent-sync/org-sync-policy-store.js";
import type { SessionFetchOptions } from "../src/main/util/api-response-utils.js";
import {
  type OrgSessionSyncPolicyState,
  OrgSessionSyncPolicyUnresolved,
  orgPolicyAllowsSessionSync,
} from "../src/shared/contracts.js";
import { deferred } from "./deferred.js";

// FEA-4169 / ISS-4623 / ISS-4705 — the OUTER org-policy sync gate. These tests
// pin the fail-closed and version-skew semantics that keep local session data
// from egressing when the server-owned org policy is off, without silently
// breaking the Closedloop org (policy on) or an old-server pairing (skew →
// degrade to device consent).
//
// ISS-4623 — the load window is no longer an unknown→allow race: an unresolved
// policy DENIES until it resolves, and the store self-heals so that denial is a
// bounded latency window rather than a permanent stall.
//
// ISS-4705 — WHICH unresolved state a field-less response lands in is decided by
// the capability marker: a buggy CURRENT server that drops only the policy field
// must fail closed, while a genuinely OLD server (no marker) still degrades.

const FETCH_OPTIONS: SessionFetchOptions = {
  getAccessToken: () => Promise.resolve("token"),
  getApiOrigin: () => "https://api.example.test",
};

/**
 * Build an identity response. Fields are omitted entirely (not set to
 * `undefined`) when not provided, so `capabilitySupported: undefined` models an
 * OLD server that never sent the `sessionSyncPolicySupported` marker, while
 * `capabilitySupported: true` models a CURRENT server that advertises it.
 */
function makeIdentity(overrides: {
  sessionSyncPolicyEnabled?: boolean;
  capabilitySupported?: boolean;
}): DesktopIdentity {
  return {
    userId: "u1",
    organizationId: "o1",
    email: "person@example.test",
    firstName: null,
    lastName: null,
    organizationName: null,
    ...(overrides.sessionSyncPolicyEnabled === undefined
      ? {}
      : { sessionSyncPolicyEnabled: overrides.sessionSyncPolicyEnabled }),
    ...(overrides.capabilitySupported === undefined
      ? {}
      : { sessionSyncPolicySupported: overrides.capabilitySupported }),
  };
}

const openStores: OrgSyncPolicyStore[] = [];

/**
 * Build a store and register it for teardown.
 *
 * Use this instead of `new OrgSyncPolicyStore(...)` in every test. A test that
 * leaves the policy unresolved arms the store's self-heal loop, and on the
 * DEFAULT injected scheduler that is a real `setTimeout` which re-arms itself
 * for as long as the policy stays `"unknown"` — i.e. forever, in a test that
 * never resolves it. Node keeps the process alive while such a timer is pending,
 * so an undisposed store here does not fail this file, it HANGS it: every test
 * reports green and the child process then never exits, wedging the whole
 * `test:node` runner until `scripts/run-node-tests.mjs` kills it
 * (`NODE_TEST_RUNNER_TIMEOUT_MS`) and the `desktop` check goes red with no named
 * failing test. `dispose()` is the store's own teardown contract and latches the
 * loop off, so taking it after every test is exactly what a real owner does.
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

// -- pure gate predicate ----------------------------------------------------

test("orgPolicyAllowsSessionSync: explicit true allows (org enabled)", () => {
  assert.equal(orgPolicyAllowsSessionSync(true), true);
});

test("orgPolicyAllowsSessionSync: explicit false DENIES (fail-closed, org off)", () => {
  assert.equal(orgPolicyAllowsSessionSync(false), false);
});

test("orgPolicyAllowsSessionSync: unknown DENIES (ISS-4623 fail-closed loading / buggy capable server)", () => {
  assert.equal(
    orgPolicyAllowsSessionSync(OrgSessionSyncPolicyUnresolved.Unknown),
    false
  );
});

test("orgPolicyAllowsSessionSync: unsupported degrades to allow (old-server version skew)", () => {
  assert.equal(
    orgPolicyAllowsSessionSync(OrgSessionSyncPolicyUnresolved.Unsupported),
    true
  );
});

// -- store: caching + fetch degrade behavior --------------------------------

test("OrgSyncPolicyStore: initial state is 'unknown' before any fetch (fail-closed)", () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(null),
  });
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
});

test("OrgSyncPolicyStore: policy-off org caches explicit false (gate DENIES)", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () =>
      Promise.resolve(
        makeIdentity({
          sessionSyncPolicyEnabled: false,
          capabilitySupported: true,
        })
      ),
  });
  const state = await store.refresh();
  assert.equal(state, false);
  assert.equal(store.getPolicyState(), false);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
});

test("OrgSyncPolicyStore: Closedloop-enabled org caches explicit true (gate defers to consent)", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () =>
      Promise.resolve(
        makeIdentity({
          sessionSyncPolicyEnabled: true,
          capabilitySupported: true,
        })
      ),
  });
  const state = await store.refresh();
  assert.equal(state, true);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), true);
});

test("OrgSyncPolicyStore: OLD server (no capability marker, no policy field) → 'unsupported' (skew → allow)", async () => {
  // ISS-4705 sub-case 1: a genuinely old server that predates the policy omits
  // BOTH the capability marker and the boolean. Preserve prior device-consent
  // so a desktop upgrade never newly suppresses an already-consented user.
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(makeIdentity({})),
  });
  const state = await store.refresh();
  assert.equal(state, OrgSessionSyncPolicyUnresolved.Unsupported);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), true);
});

test("OrgSyncPolicyStore: BUGGY CURRENT server (capability marker present, policy field dropped) → 'unknown' (FAILS CLOSED)", async () => {
  // ISS-4705 sub-case 2: a current server advertises policy support but returns
  // an otherwise well-formed identity missing ONLY sessionSyncPolicyEnabled.
  // Field-presence alone can't tell this from an old server, so the capability
  // marker forces fail-closed instead of the skew degrade.
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () =>
      Promise.resolve(makeIdentity({ capabilitySupported: true })),
  });
  const state = await store.refresh();
  assert.equal(state, OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
});

test("OrgSyncPolicyStore: null/failed fetch keeps last-known explicit state (no clobber)", async () => {
  let response: DesktopIdentity | null = makeIdentity({
    sessionSyncPolicyEnabled: false,
    capabilitySupported: true,
  });
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(response),
  });
  await store.refresh();
  assert.equal(store.getPolicyState(), false);
  // Subsequent transient outage returns null — must not flip false → unresolved.
  response = null;
  await store.refresh();
  assert.equal(store.getPolicyState(), false);
});

test("OrgSyncPolicyStore: field dropped by an OLD server does not reset an explicit value", async () => {
  let response: DesktopIdentity = makeIdentity({
    sessionSyncPolicyEnabled: true,
    capabilitySupported: true,
  });
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(response),
  });
  await store.refresh();
  assert.equal(store.getPolicyState(), true);
  // A later response from a node that never advertised the capability is an OLD
  // server in a mixed fleet — it cannot speak to the policy at all, so it must
  // not clobber the authoritative value that a capable server already resolved.
  response = makeIdentity({});
  await store.refresh();
  assert.equal(store.getPolicyState(), true);
});

test("OrgSyncPolicyStore: a CAPABLE server that drops the field fails CLOSED over a cached allow", async () => {
  // chatgpt-codex-connector review (P1): the store's own contract is that a
  // capable server's malformed answer must never be read as "allow". Letting an
  // earlier cached `true` survive it did exactly that, so a server that
  // advertises `sessionSyncPolicySupported` but omits the boolean now drives the
  // state to the fail-closed `"unknown"` even when an explicit value was cached.
  let response: DesktopIdentity = makeIdentity({
    sessionSyncPolicyEnabled: true,
    capabilitySupported: true,
  });
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(response),
  });
  await store.refresh();
  assert.equal(store.getPolicyState(), true);
  response = makeIdentity({ capabilitySupported: true });
  await store.refresh();
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
  // Recoverable: the next well-formed answer resolves the policy again.
  response = makeIdentity({
    sessionSyncPolicyEnabled: true,
    capabilitySupported: true,
  });
  await store.refresh();
  assert.equal(store.getPolicyState(), true);
});

test("OrgSyncPolicyStore: a refresh in flight across reset() cannot install the previous account's policy", async () => {
  // wongk review: account A's `true` was still in flight when the auth-session
  // change reset the store for account B. Without a generation guard that late
  // write lands after the reset and re-opens session egress for an org that may
  // have the policy off. The stale answer must be discarded on arrival.
  const parkedFetch = deferred<DesktopIdentity>();
  let fetchStarted = false;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => {
      fetchStarted = true;
      return parkedFetch.promise;
    },
  });
  // Account A's refresh starts and parks on the transport.
  const inFlight = store.refresh();
  // Account switch lands while it is parked.
  store.reset();
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.ok(fetchStarted, "the fetch was started and is awaiting a response");
  parkedFetch.resolve(
    makeIdentity({
      sessionSyncPolicyEnabled: true,
      capabilitySupported: true,
    })
  );
  const resolved = await inFlight;
  assert.equal(
    resolved,
    OrgSessionSyncPolicyUnresolved.Unknown,
    "the stale in-flight answer was discarded, not returned as the new state"
  );
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
});

test("OrgSyncPolicyStore: no fetch options (no session yet) keeps state unchanged", async () => {
  const store = createStore({
    getFetchOptions: () => null,
    fetchIdentity: () =>
      Promise.resolve(
        makeIdentity({
          sessionSyncPolicyEnabled: true,
          capabilitySupported: true,
        })
      ),
  });
  const state = await store.refresh();
  assert.equal(state, OrgSessionSyncPolicyUnresolved.Unknown);
});

test("OrgSyncPolicyStore: a thrown fetch is swallowed, state unchanged", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.reject(new Error("boom")),
  });
  const state = await store.refresh();
  assert.equal(state, OrgSessionSyncPolicyUnresolved.Unknown);
});

test("OrgSyncPolicyStore: reset() clears an explicit value back to 'unknown' (account switch, fail-closed)", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () =>
      Promise.resolve(
        makeIdentity({
          sessionSyncPolicyEnabled: true,
          capabilitySupported: true,
        })
      ),
  });
  await store.refresh();
  assert.equal(store.getPolicyState(), true);
  // Account switch: the previous account's explicit `true` must not linger and
  // gate the new account before its own policy is fetched.
  store.reset();
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
});

// -- ISS-4623: the loading → resolved transition ----------------------------

test("ISS-4623: the gate DENIES for the whole load window, then allows once the policy resolves true", async () => {
  const pending = deferred<DesktopIdentity | null>();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => pending.promise,
  });
  const gateAllows = () => orgPolicyAllowsSessionSync(store.getPolicyState());

  // Pre-fetch: nothing resolved yet, so the outer gate must fail closed.
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(gateAllows(), false);

  const refreshed = store.refresh();
  // Mid-flight: "still loading" must not read as consent.
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(gateAllows(), false);

  pending.resolve(
    makeIdentity({ sessionSyncPolicyEnabled: true, capabilitySupported: true })
  );
  assert.equal(await refreshed, true);
  // Resolved: the org-policy gate opens and defers to the per-device tier gate.
  assert.equal(gateAllows(), true);
});

test("ISS-4623: a load window that resolves false stays denied", async () => {
  const pending = deferred<DesktopIdentity | null>();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => pending.promise,
  });
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
  const refreshed = store.refresh();
  pending.resolve(
    makeIdentity({ sessionSyncPolicyEnabled: false, capabilitySupported: true })
  );
  assert.equal(await refreshed, false);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
});

test("ISS-4623: reset during an in-flight refresh discards the previous account's policy", async () => {
  const pending = deferred<DesktopIdentity | null>();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => pending.promise,
  });
  const inFlight = store.refresh();
  // Account switch lands while the previous account's identity is in flight.
  store.reset();
  pending.resolve(
    makeIdentity({ sessionSyncPolicyEnabled: true, capabilitySupported: true })
  );

  assert.equal(await inFlight, OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), false);
});

test("ISS-4623: concurrent refreshes share one identity request", async () => {
  let calls = 0;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => {
      calls += 1;
      return Promise.resolve(
        makeIdentity({
          sessionSyncPolicyEnabled: true,
          capabilitySupported: true,
        })
      );
    },
  });
  const [first, second] = await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(calls, 1);
  assert.equal(first, true);
  assert.equal(second, true);
});

// -- ISS-4623: self-healing so fail-closed is a latency window, not a stall --

test("ISS-4623: ensureResolved retries an unresolved policy, throttled, and stops once resolved", async () => {
  let now = 1000;
  let calls = 0;
  let response: DesktopIdentity | null = null;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => {
      calls += 1;
      return Promise.resolve(response);
    },
    now: () => now,
  });

  // The first gate evaluation while unresolved kicks a best-effort refresh; the
  // server is unreachable, so the state stays fail-closed.
  await store.ensureResolved();
  assert.equal(calls, 1);
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);

  // Inside the throttle window: later ticks must not re-request per tick.
  now += 1000;
  assert.equal(store.ensureResolved(), null);
  assert.equal(calls, 1);

  // Past the window: retry, and this time the server answers.
  now += UNRESOLVED_REFRESH_MIN_INTERVAL_MS;
  response = makeIdentity({
    sessionSyncPolicyEnabled: true,
    capabilitySupported: true,
  });
  await store.ensureResolved();
  assert.equal(calls, 2);
  assert.equal(store.getPolicyState(), true);

  // Resolved: no further self-heal requests, however long the app runs.
  now += 10 * UNRESOLVED_REFRESH_MIN_INTERVAL_MS;
  assert.equal(store.ensureResolved(), null);
  assert.equal(calls, 2);
});

test("ISS-4623: ensureResolved stops once an old server resolved 'unsupported'", async () => {
  let now = 1000;
  let calls = 0;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => {
      calls += 1;
      return Promise.resolve(makeIdentity({}));
    },
    now: () => now,
  });
  await store.ensureResolved();
  assert.equal(calls, 1);
  assert.equal(
    store.getPolicyState(),
    OrgSessionSyncPolicyUnresolved.Unsupported
  );

  now += 10 * UNRESOLVED_REFRESH_MIN_INTERVAL_MS;
  assert.equal(store.ensureResolved(), null);
  assert.equal(calls, 1);
});

test("ISS-4623: reset re-arms the self-heal for the next account immediately", async () => {
  const now = 1000;
  let calls = 0;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => {
      calls += 1;
      return Promise.resolve(null);
    },
    now: () => now,
  });
  await store.ensureResolved();
  assert.equal(calls, 1);
  // Same clock reading: without the reset the throttle would suppress a retry.
  assert.equal(store.ensureResolved(), null);
  assert.equal(calls, 1);

  // An account switch inside the throttle window must not inherit the previous
  // account's cooldown — the new account needs its policy right away.
  store.reset();
  await store.ensureResolved();
  assert.equal(calls, 2);
});

// -- ISS-4623: resolution must re-kick lanes that tore their timer down ------
//
// The metadata sync lanes clear their tick timer whenever their readiness gate
// says no, so a lane suppressed by the fail-closed load window stops evaluating
// the gate entirely. Without a transition notification it could never observe
// the policy resolving to `true`, and the fail-closed window would become a
// permanent stall instead of a latency window.

test("ISS-4623: subscribers are notified when the load window resolves to allow", async () => {
  const pending = deferred<DesktopIdentity | null>();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => pending.promise,
  });
  const observed: OrgSessionSyncPolicyState[] = [];
  store.subscribe(() => {
    observed.push(store.getPolicyState());
  });

  const refreshed = store.refresh();
  // Still loading: nothing changed, so no lane should have been kicked yet.
  assert.deepEqual(observed, []);

  pending.resolve(
    makeIdentity({ sessionSyncPolicyEnabled: true, capabilitySupported: true })
  );
  await refreshed;
  // The lane that disarmed itself during the load window learns it may resume.
  assert.deepEqual(observed, [true]);
});

test("ISS-4623: subscribers are notified on the deny and account-switch transitions too", async () => {
  let response: DesktopIdentity | null = makeIdentity({
    sessionSyncPolicyEnabled: true,
    capabilitySupported: true,
  });
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(response),
  });
  const observed: OrgSessionSyncPolicyState[] = [];
  store.subscribe(() => {
    observed.push(store.getPolicyState());
  });

  await store.refresh();
  // An admin turning the org policy off must reach the lanes immediately.
  response = makeIdentity({
    sessionSyncPolicyEnabled: false,
    capabilitySupported: true,
  });
  await store.refresh();
  // Account switch: back to the fail-closed unresolved state.
  store.reset();

  assert.deepEqual(observed, [
    true,
    false,
    OrgSessionSyncPolicyUnresolved.Unknown,
  ]);
});

test("ISS-4623: an unchanged policy does not re-notify, and unsubscribe stops delivery", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () =>
      Promise.resolve(
        makeIdentity({
          sessionSyncPolicyEnabled: true,
          capabilitySupported: true,
        })
      ),
  });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  await store.refresh();
  assert.equal(notifications, 1);
  // Same value on the next poll — re-kicking every lane per poll would be churn.
  await store.refresh();
  assert.equal(notifications, 1);

  unsubscribe();
  store.reset();
  assert.equal(notifications, 1);
});

test("ISS-4623: a lane that tore its timer down during the load window resumes on resolution", async () => {
  const pending = deferred<DesktopIdentity | null>();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => pending.promise,
  });
  // Models the real lane contract (AgentSessionSyncService.refresh /
  // AgentComponentInvocationSyncService.refresh): a readiness check that says
  // no CLEARS the tick timer, so the lane stops evaluating the gate entirely
  // and only an external refresh() can arm it again.
  let timerArmed = false;
  const lane = {
    refresh() {
      timerArmed = orgPolicyAllowsSessionSync(store.getPolicyState());
    },
  };
  store.subscribe(() => lane.refresh());

  // Boot: the lane's first readiness check lands inside the load window.
  lane.refresh();
  assert.equal(timerArmed, false);

  const refreshed = store.refresh();
  pending.resolve(
    makeIdentity({ sessionSyncPolicyEnabled: true, capabilitySupported: true })
  );
  await refreshed;

  // No cloud reconnect, no auth change, no other external event fired — the
  // policy resolving is what has to bring the lane back.
  assert.equal(timerArmed, true);
});

test("ISS-4623: a throwing subscriber cannot break the gate or strand its peers", async () => {
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () =>
      Promise.resolve(
        makeIdentity({
          sessionSyncPolicyEnabled: true,
          capabilitySupported: true,
        })
      ),
  });
  let secondNotified = false;
  store.subscribe(() => {
    throw new Error("lane kick blew up");
  });
  store.subscribe(() => {
    secondNotified = true;
  });

  assert.equal(await store.refresh(), true);
  assert.equal(secondNotified, true);
  assert.equal(orgPolicyAllowsSessionSync(store.getPolicyState()), true);
});

// -- ISS-4623 (follow-up): the store's OWN self-heal timer -------------------
//
// The gate-driven `ensureResolved` retry is not enough on its own: the sync
// lanes tear their tick timer down while the fail-closed gate says no, so once
// the FIRST startup fetch fails nothing calls the gate — and thus
// `ensureResolved` — again. The store therefore drives its own self-heal loop
// while unresolved, independent of any lane, and stops it once resolved / reset.

type ControllableTimers = {
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  /** Fires every currently-scheduled timer whose delay matches, once. */
  fireDue: () => Promise<void>;
  pending: () => number;
};

function makeControllableTimers(): ControllableTimers {
  const scheduled = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer: (callback) => {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, callback);
      return id as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      scheduled.delete(handle as unknown as number);
    },
    fireDue: async () => {
      const due = [...scheduled.entries()];
      scheduled.clear();
      for (const [, callback] of due) {
        callback();
      }
      // The fired callback kicks an async refresh whose promise chain (fetch +
      // finally + re-arm hook) settles over several microtask hops. A macrotask
      // yield deterministically flushes the ENTIRE pending microtask queue, so
      // the assertion reads fully-settled state (no fixed tick-count window).
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    pending: () => scheduled.size,
  };
}

test("ISS-4623: the store self-heals an unresolved policy without any caller re-pumping the gate", async () => {
  const timers = makeControllableTimers();
  let calls = 0;
  let response: DesktopIdentity | null = null;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => {
      calls += 1;
      return Promise.resolve(response);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  // Boot: the ONE refresh the wiring issues fails (server unreachable). This
  // models the lanes then tearing their timers down — nothing will call the
  // gate again.
  await store.refresh();
  assert.equal(calls, 1);
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  // A self-heal timer is armed even though no caller pumps the gate.
  assert.equal(timers.pending(), 1);

  // The self-heal timer fires: it re-fetches on its own. Still unreachable, so
  // it re-arms itself.
  await timers.fireDue();
  assert.equal(calls, 2);
  assert.equal(store.getPolicyState(), OrgSessionSyncPolicyUnresolved.Unknown);
  assert.equal(timers.pending(), 1);

  // The server comes back: the next self-heal fetch resolves the policy and the
  // loop stops — no timer left scheduled however long the app runs.
  response = makeIdentity({
    sessionSyncPolicyEnabled: true,
    capabilitySupported: true,
  });
  await timers.fireDue();
  assert.equal(calls, 3);
  assert.equal(store.getPolicyState(), true);
  assert.equal(timers.pending(), 0);
});

test("ISS-4623: reset cancels the previous account's self-heal timer", async () => {
  const timers = makeControllableTimers();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(null),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await store.refresh();
  assert.equal(timers.pending(), 1);

  // An account switch must not leave the prior account's self-heal cycle running.
  store.reset();
  assert.equal(timers.pending(), 0);
});

test("ISS-4623: the self-heal loop schedules exactly one timer at a time", async () => {
  const timers = makeControllableTimers();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(null),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  // Multiple gate evaluations while unresolved must not stack timers.
  await store.refresh();
  await store.refresh();
  await store.refresh();
  assert.equal(timers.pending(), 1);
  assert.equal(
    UNRESOLVED_SELF_HEAL_INTERVAL_MS,
    UNRESOLVED_REFRESH_MIN_INTERVAL_MS
  );
});

// -- ISS-4623 (shafty023 review): idempotent teardown of the self-heal loop ---
//
// The lane-subscription dispose stops the re-kick, but the store's OWN self-heal
// timer could still fire during shutdown, refresh(), and re-arm. dispose() must
// latch the loop off so nothing re-fetches or re-arms once teardown starts.

test("ISS-4623: dispose() clears the pending self-heal timer", async () => {
  const timers = makeControllableTimers();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(null),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await store.refresh();
  assert.equal(timers.pending(), 1);

  store.dispose();
  assert.equal(timers.pending(), 0);
});

test("ISS-4623: after dispose the self-heal loop never re-fetches or re-arms", async () => {
  const timers = makeControllableTimers();
  let calls = 0;
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => {
      calls += 1;
      return Promise.resolve(null);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await store.refresh();
  assert.equal(calls, 1);
  assert.equal(timers.pending(), 1);

  // Teardown: dispose clears the armed timer; a subsequent refresh (e.g. from a
  // late transition) must not re-arm the loop, and firing any straggler timer
  // must not re-fetch.
  store.dispose();
  assert.equal(timers.pending(), 0);
  await store.refresh();
  assert.equal(timers.pending(), 0);
  await timers.fireDue();
  // Only the boot refresh + the explicit post-dispose refresh ran; no self-heal
  // fetch fired and nothing re-armed.
  assert.equal(calls, 2);
  assert.equal(timers.pending(), 0);
});

test("ISS-4623: dispose() is idempotent", async () => {
  const timers = makeControllableTimers();
  const store = createStore({
    getFetchOptions: () => FETCH_OPTIONS,
    fetchIdentity: () => Promise.resolve(null),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await store.refresh();
  store.dispose();
  store.dispose();
  assert.equal(timers.pending(), 0);
});
