/**
 * @file session-sync-identity-refusal-reason.test.ts
 * @description ISS-11467 — the two refusal reasons the resolver reports, EXECUTED
 * against the real adapter.
 *
 * This is the producer half, and it needs its own coverage because every
 * composition-level case injects the reason as fixture data. Without these cases the
 * whole production chain that PRODUCES `ComputeTargetRefusalReason.ForeignAccount` —
 * `resolve()` recording it, `lastLiveTargetRefusal()` handing it out, the lane deps
 * forwarding it — could be deleted with every other suite still green, and the
 * ISS-11426 relink would silently stop appearing on exactly the account-switch state
 * it exists for. That state no longer produces a server 403 at all, because no lane
 * sends the foreign id, so the resolver is the only thing left that can report it.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { identityBoundComputeTargetId } from "../src/main/agent-sync/identity-bound-compute-target.js";
import {
  ComputeTargetRefusalReason,
  createSessionSyncIdentityAdapter,
} from "../src/main/agent-sync/retained-compute-target-identity.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";

const TARGET = "ct-11467-readers";
const ORIGIN_A = "https://api.origin-a.test";
const ORIGIN_B = "https://api.origin-b.test";
const ACCOUNT: SignedInUserIdentity = {
  userId: "user-1",
  organizationId: "org-1",
};
const OTHER_ACCOUNT: SignedInUserIdentity = {
  userId: "user-2",
  organizationId: "org-2",
};

type MutableState = {
  identity: SignedInUserIdentity | null;
  authStatus: DesktopAuthStatus;
  apiOrigin: string;
  onlineTargetId: string | null;
};

test("ISS-11467: the identity-bound fold declines the target the online read still names after an account switch", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  const bound = () =>
    identityBoundComputeTargetId(
      adapter.onlineComputeTargetId(),
      adapter.computeTargetId()
    );
  assert.equal(adapter.onlineComputeTargetId(), TARGET);
  assert.equal(bound(), TARGET);

  // The socket keeps naming the previous account's target — an account switch is
  // precisely the event that produces no fresh hello — and only the bound fold
  // declines it. Every sync lane resolves through that fold.
  state.identity = OTHER_ACCOUNT;
  assert.equal(adapter.onlineComputeTargetId(), TARGET);
  assert.equal(
    bound(),
    null,
    "this is the read that stops a known-foreign id leaving the machine"
  );
});

test("ISS-11467: the adapter REPORTS which gate refused a live id, so a caller can tell a relinkable account switch from a transient origin flip", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  assert.equal(adapter.computeTargetId(), TARGET);
  assert.equal(
    adapter.lastLiveTargetRefusal(),
    null,
    "a read that refused nothing must report nothing, or a stale reason latches a relink on an ordinary tick"
  );

  state.identity = OTHER_ACCOUNT;
  assert.equal(adapter.computeTargetId(), null);
  assert.equal(
    adapter.lastLiveTargetRefusal(),
    ComputeTargetRefusalReason.ForeignAccount,
    "no lane spends a batch discovering this state any more, so the resolver is the only thing left that can say the relink is the remedy"
  );

  state.identity = ACCOUNT;
  assert.equal(adapter.computeTargetId(), TARGET);
  assert.equal(
    adapter.lastLiveTargetRefusal(),
    null,
    "and it clears on the next read that resolves, so the relink is not offered after the switch is undone"
  );
});

test("ISS-11467: an ISS-8702 origin refusal reports MintedElsewhere, which must never raise the relink", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  assert.equal(adapter.computeTargetId(), TARGET);

  state.apiOrigin = ORIGIN_B;
  assert.equal(adapter.computeTargetId(), null);
  assert.equal(
    adapter.lastLiveTargetRefusal(),
    ComputeTargetRefusalReason.MintedElsewhere,
    "the reconnect this profile change triggers clears it, so a relink prompt here would be a prompt for a condition that fixes itself"
  );
});

function signedInState(): MutableState {
  return {
    identity: ACCOUNT,
    authStatus: DesktopAuthStatus.Authenticated,
    apiOrigin: ORIGIN_A,
    onlineTargetId: TARGET,
  };
}

function adapterOver(state: MutableState) {
  return createSessionSyncIdentityAdapter({
    getIdentity: () => state.identity,
    getAuthStatus: () => state.authStatus,
    getApiOrigin: () => state.apiOrigin,
    getCloudStatus: () =>
      state.onlineTargetId
        ? { state: CloudSocketState.Online, targetId: state.onlineTargetId }
        : { state: CloudSocketState.Idle },
  });
}
