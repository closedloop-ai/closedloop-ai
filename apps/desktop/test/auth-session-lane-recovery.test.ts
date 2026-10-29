import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type AuthSessionAccountIdentity,
  type AuthSessionLaneKicks,
  wireAuthSessionLaneRecovery,
} from "../src/main/agent-sync/auth-session-lane-recovery.js";

// ISS-9418 / ISS-8610 — the auth-session → lane-recovery seam, and the identity
// diff that decides which door an auth-state notification opens.
//
// ISS-11449 renamed this module from `org-sync-policy-subscription.ts`, whose
// store subscription went with the org sync policy. What these cases pin is the
// half that survived and is the only reason the module still exists: the diff
// itself, and the shutdown gate around it.

const ACCOUNT_A: AuthSessionAccountIdentity = {
  userId: "u1",
  organizationId: "o1",
};

const ACCOUNT_B: AuthSessionAccountIdentity = {
  userId: "u2",
  organizationId: "o2",
};

function makeCounters(): {
  laneKicks: AuthSessionLaneKicks;
  laneRecovery: () => number;
  credentialsRefreshed: () => number;
} {
  let laneRecovery = 0;
  let credentialsRefreshed = 0;
  return {
    laneKicks: {
      noteLaneRecoverySignal: () => {
        laneRecovery += 1;
      },
      noteCredentialsRefreshed: () => {
        credentialsRefreshed += 1;
      },
    },
    laneRecovery: () => laneRecovery,
    credentialsRefreshed: () => credentialsRefreshed,
  };
}

test("ISS-9418: a routine same-account token renewal opens NO give-up recovery door", () => {
  // The whole point of putting this behind the identity diff. `applyTokens`
  // calls `setState(Authenticated, ...)` on EVERY successful access-token
  // refresh, and `DesktopSessionManager.subscribe` notifies unconditionally on
  // that — so a recovery signal fired from the raw callback re-arms a given-up
  // lane on a cadence far shorter than the widening 5min→24h window, which is
  // the 24h ceiling defeated by an event that says nothing about the cloud.
  const counters = makeCounters();
  const recovery = wireAuthSessionLaneRecovery({
    laneKicks: counters.laneKicks,
    isShuttingDown: () => false,
    // Unchanged across the renewal, which is what a token refresh looks like.
    getAccountIdentity: () => ACCOUNT_A,
  });

  recovery.onAuthSessionChange();
  recovery.onAuthSessionChange();
  recovery.onAuthSessionChange();
  assert.equal(
    counters.laneRecovery(),
    0,
    "three token refreshes, no free re-arms"
  );
  // ISS-8610: but each one IS the narrow pacing door. Asserted here rather than
  // in its own case so the pair cannot drift into both branches firing, which is
  // the failure this seam exists to prevent: a give-up re-armed on the refresh
  // cadence.
  assert.equal(
    counters.credentialsRefreshed(),
    3,
    "every renewal ends the environmental pacing window"
  );
});

test("ISS-9418: a genuine account switch DOES open the give-up recovery door", () => {
  // The positive sibling: the credentials a lane gave up under may be exactly
  // what changed, so an identity transition must still buy it one attempt. A
  // diff that answered `false` for everything would pass the case above on its
  // own and remove the door entirely.
  let currentAccount: AuthSessionAccountIdentity | null = ACCOUNT_A;
  const counters = makeCounters();
  const recovery = wireAuthSessionLaneRecovery({
    laneKicks: counters.laneKicks,
    isShuttingDown: () => false,
    getAccountIdentity: () => currentAccount,
  });

  currentAccount = ACCOUNT_B;
  recovery.onAuthSessionChange();
  assert.equal(counters.laneRecovery(), 1, "an account switch is a door");

  currentAccount = null;
  recovery.onAuthSessionChange();
  assert.equal(counters.laneRecovery(), 2, "and so is signing out");

  // ...but the door stays shut once it is the same account again.
  recovery.onAuthSessionChange();
  assert.equal(counters.laneRecovery(), 2);
  // ISS-8610: and an identity transition is NOT a credential renewal — only the
  // same-account branch above reports one, so the two seams stay distinguishable.
  assert.equal(
    counters.credentialsRefreshed(),
    1,
    "only the same-account tick reported a renewal"
  );
});

test("onAuthSessionChange no-ops during shutdown", () => {
  // A notification can land DURING teardown, after the lanes were stopped, and a
  // re-arm then could restart an upload mid-teardown. The owner also drops its
  // handle before stopping the lanes; this gate is the backstop behind that.
  let currentAccount: AuthSessionAccountIdentity | null = ACCOUNT_A;
  const counters = makeCounters();
  const recovery = wireAuthSessionLaneRecovery({
    laneKicks: counters.laneKicks,
    isShuttingDown: () => true,
    getAccountIdentity: () => currentAccount,
  });

  // Both branches of the diff, so neither can leak through the gate.
  recovery.onAuthSessionChange();
  currentAccount = ACCOUNT_B;
  recovery.onAuthSessionChange();

  assert.equal(counters.laneRecovery(), 0);
  assert.equal(counters.credentialsRefreshed(), 0);
});
