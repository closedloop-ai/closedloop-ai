/**
 * @file persisted-compute-target-origin-scope.test.ts
 * @description ISS-9003 — the trace-comment accessor's PERSISTED fallback is
 * origin-scoped, closing the window ISS-8702 (PR #6527) named and deliberately
 * left open because it needed a field in the saved config.
 *
 * Its own file rather than appended to `session-sync-identity-adapter.test.ts`:
 * that suite is already ~1.1k lines, and its subject is the in-memory retained
 * id, which a restart clears. The subject here is the saved pair that outlives
 * the process — the only thing this accessor has before the first hello, and
 * therefore the only place an id can be presented to a foreign origin
 * indefinitely rather than for one reconnect.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSessionSyncIdentityAdapter,
  type PersistedComputeTarget,
} from "../src/main/agent-sync/retained-compute-target-identity.js";
import { sanitizeSavedConfig } from "../src/main/settings/saved-config.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import {
  DesktopAuthStatus,
  type SavedConfig,
} from "../src/shared/contracts.js";
import { normalizeEnvironmentKey } from "../src/shared/environment-key.js";

const TARGET = "iss9003-compute-target";
const LIVE_TARGET = "iss9003-live-target";
/** Two environments one install can be pointed at, i.e. a profile switch. */
const ORIGIN_A = "https://api.origin-a.test";
const ORIGIN_B = "https://api.origin-b.test";
const ACCOUNT: SignedInUserIdentity = {
  userId: "user-1",
  organizationId: "org-1",
};

type State = { apiOrigin: string; onlineTargetId: string | null };

function adapterOver(state: State) {
  return createSessionSyncIdentityAdapter({
    getIdentity: () => ACCOUNT,
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
    getApiOrigin: () => state.apiOrigin,
    getCloudStatus: () =>
      state.onlineTargetId
        ? { state: CloudSocketState.Online, targetId: state.onlineTargetId }
        : { state: CloudSocketState.Idle },
  });
}

/**
 * A fresh process pointed at `apiOrigin` holding only what a previous run left
 * in the saved config, with the socket down. That is the whole reason this
 * fallback exists and the only state in which it is consulted.
 */
function restartedOn(
  apiOrigin: string,
  saved: PersistedComputeTarget | null
): string | null {
  return adapterOver({
    apiOrigin,
    onlineTargetId: null,
  }).cloudReadComputeTargetId(saved);
}

/** What `app.ts` writes to the saved config on an online transition. */
function helloOn(
  apiOrigin: string,
  online: { targetId: string; mintingApiOrigin?: string }
): PersistedComputeTarget {
  return adapterOver({ apiOrigin, onlineTargetId: online.targetId }).remember(
    online
  );
}

/** A profile as it comes off disk, with the pair overridden per case. */
function savedProfile(pair: Record<string, unknown>): SavedConfig {
  return {
    id: "profile-1",
    name: "Profile 1",
    relayOrigin: ORIGIN_A,
    apiOrigin: ORIGIN_A,
    webAppOrigin: ORIGIN_A,
    ...pair,
  } as unknown as SavedConfig;
}

test("ISS-9003: a persisted id minted under origin A is never presented to origin B", () => {
  const saved = helloOn(ORIGIN_A, { targetId: TARGET });

  assert.equal(
    restartedOn(ORIGIN_B, saved),
    null,
    "the saved id belongs to origin A and origin B must not be handed it"
  );
  // The positive sibling: the SAME saved pair, back on the origin that minted
  // it. Without this a fallback that refused everything would pass the line
  // above while darking trace-comment sync on every install.
  assert.equal(
    restartedOn(ORIGIN_A, saved),
    TARGET,
    "and the origin that minted it must still get it back"
  );
});

test("ISS-9003: the stamp is the environment KEY, so a respelled origin is not a mismatch", () => {
  const saved = helloOn("https://API.Origin-A.test/", { targetId: TARGET });

  // Case and a trailing slash normalize to one key; comparing raw strings here
  // would refuse a profile that never moved.
  assert.equal(restartedOn(ORIGIN_A, saved), TARGET);
  assert.equal(restartedOn(ORIGIN_B, saved), null);

  // The persisted side is normalized on read too, so a profile that stored a raw
  // origin instead of a key is not refused for having moved when it did not.
  assert.equal(
    restartedOn(ORIGIN_A, {
      lastComputeTargetId: TARGET,
      lastComputeTargetEnvironmentKey: "https://API.Origin-A.test/",
    }),
    TARGET
  );
});

test("ISS-9003: an ack that states its minting origin outranks the origin we posted to", () => {
  // ISS-9081's field, carried through to the persisted half: the relay resolved
  // this target against origin A while this profile says B, so B must not keep
  // the id across a restart either.
  const saved = helloOn(ORIGIN_B, {
    targetId: TARGET,
    mintingApiOrigin: ORIGIN_A,
  });

  assert.equal(restartedOn(ORIGIN_B, saved), null);
  assert.equal(restartedOn(ORIGIN_A, saved), TARGET);
});

test("ISS-9003: a saved config predating the field is refused, and one hello restores it", () => {
  // The back-compat window, asserted as the DECIDED behavior rather than
  // whatever the read happens to do with a missing key: an id with no recorded
  // origin is unknown, and unknown is refused.
  const legacy: PersistedComputeTarget = { lastComputeTargetId: TARGET };
  assert.equal(
    restartedOn(ORIGIN_A, legacy),
    null,
    "an id with no recorded minting origin proves nothing about this one"
  );
  assert.equal(
    restartedOn(ORIGIN_A, {
      lastComputeTargetId: TARGET,
      lastComputeTargetEnvironmentKey: null,
    }),
    null,
    "and an explicit null key is the same answer as a missing one"
  );

  // Self-healing is what makes refusing the cheaper error: the very next online
  // transition stamps the pair and the fallback is back.
  const stamped = helloOn(ORIGIN_A, { targetId: TARGET });
  assert.equal(stamped.lastComputeTargetId, TARGET);
  assert.equal(restartedOn(ORIGIN_A, stamped), TARGET);
});

test("ISS-9003: a saved pair with a non-string half never reaches the fallback", () => {
  // `isSavedConfig` guards only the five always-present strings, so both halves
  // are whatever the JSON on disk held. A one-element array is the case that is
  // not inert (whitlockk, #7142) — this is the coercion the load boundary closes,
  // asserted so a future `normalizeEnvironmentKey` that rejects it says so here
  // rather than leaving the guard looking like dead code.
  assert.equal(
    normalizeEnvironmentKey([ORIGIN_A] as unknown as string),
    ORIGIN_A,
    "an array stamp stringifies through new URL() into a nameable key"
  );

  assert.equal(
    restartedOn(
      ORIGIN_A,
      sanitizeSavedConfig(
        savedProfile({
          lastComputeTargetId: TARGET,
          lastComputeTargetEnvironmentKey: [ORIGIN_A],
        })
      )
    ),
    null,
    "so the load boundary voids the pair and the unstamped rule refuses it"
  );
  assert.equal(
    restartedOn(
      ORIGIN_A,
      sanitizeSavedConfig(
        savedProfile({
          lastComputeTargetId: [TARGET],
          lastComputeTargetEnvironmentKey: ORIGIN_A,
        })
      )
    ),
    null,
    "and a non-string id is never handed back to sync as one"
  );

  // The positive sibling: voiding every pair would pass both lines above.
  assert.equal(
    restartedOn(
      ORIGIN_A,
      sanitizeSavedConfig(
        savedProfile({
          lastComputeTargetId: TARGET,
          lastComputeTargetEnvironmentKey: ORIGIN_A,
        })
      )
    ),
    TARGET
  );
});

test("ISS-9003: the live hello-derived target still wins over any saved pair", () => {
  // The gate is on the PERSISTED fallback only. While the socket is up the id
  // came from this connection's own hello, and refusing it would dark the lane
  // for a reason this ticket never claimed.
  const foreign = helloOn(ORIGIN_A, { targetId: TARGET });
  const live = adapterOver({
    apiOrigin: ORIGIN_B,
    onlineTargetId: LIVE_TARGET,
  });

  assert.equal(live.cloudReadComputeTargetId(foreign), LIVE_TARGET);
  assert.equal(live.cloudReadComputeTargetId(null), LIVE_TARGET);
});

test("ISS-9003: nothing saved resolves null rather than throwing", () => {
  assert.equal(restartedOn(ORIGIN_A, null), null);
  assert.equal(
    restartedOn(ORIGIN_A, {
      lastComputeTargetId: null,
      lastComputeTargetEnvironmentKey: ORIGIN_A,
    }),
    null
  );
});
