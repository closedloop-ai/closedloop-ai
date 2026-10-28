/**
 * @file session-sync-identity-adapter.test.ts
 * @description ISS-8691 — the session lane must keep writing while the cloud
 * socket is reconnecting.
 *
 * The defect these tests pin: session sync is an authenticated HTTP POST that
 * never needed the socket, but its readiness predicate asked `cloudOnline`
 * because the compute-target identity was only ever hello-derived. On the
 * 2026-08-31 incident target the relay was tearing the socket down on `ping
 * timeout` after ~45s and the client re-dialled ~15 minutes later, so the lane
 * had a ~5% duty cycle over a healthy HTTP path and sessions reached the cloud
 * 15-60 minutes late.
 *
 * The behavioral cases below drive the real `AgentSessionSyncService` against
 * the real adapter, with the socket OFFLINE, and assert the batch actually left.
 * Each carries the counterfactual that fails on the pre-fix build (a
 * strict-online resolver sends nothing), because a test that only asserted "the
 * lane sent" would pass on either build whenever the socket happened to be up.
 *
 * The identity cases are the other half, and they are the reason this is not
 * simply "cache the last id": a retained target must never outlive the account
 * that owned it (`main/sync/AGENTS.md` invariant 2).
 *
 * ISS-8702 adds the environment to that identity — same rule, second axis: a
 * retained target must never outlive the ORIGIN that minted it either. Those
 * cases are grouped at the foot of this file.
 */
import assert from "node:assert/strict";
import type { CallExpression, Node, SourceFile } from "typescript6";
import {
  forEachChild,
  isCallExpression,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  SyntaxKind,
} from "typescript6";
import { test } from "vitest";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  createRetainedComputeTargetIdentity,
  createSessionSyncIdentityAdapter,
} from "../src/main/agent-sync/retained-compute-target-identity.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { buildSharedAgentSessionsListOptions } from "../src/main/dashboard/rebuild-sync-compute-target.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { pumpSyncDrainTurn } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import { adoptedFromHelloAckFrame } from "./helpers/hello-ack-adoption.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";
import {
  parseAppModule,
  parseSyncLaneDepsModule,
} from "./support/app-module-ast.js";

const TARGET = "iss8691-compute-target";
const OTHER_TARGET = "iss8691-other-target";
/** Two environments one install can be pointed at, i.e. a profile switch. */
const ORIGIN_A = "https://api.origin-a.test";
const ORIGIN_B = "https://api.origin-b.test";
const ACCOUNT: SignedInUserIdentity = {
  userId: "user-1",
  organizationId: "org-1",
};
const SAME_USER_OTHER_ORG: SignedInUserIdentity = {
  userId: "user-1",
  organizationId: "org-2",
};
const OTHER_ACCOUNT: SignedInUserIdentity = {
  userId: "user-2",
  organizationId: "org-2",
};

/** How many drain turns to pump before declaring the lane wedged. */
const DRAIN_TURNS = 200;

type MutableState = {
  identity: SignedInUserIdentity | null;
  authStatus: DesktopAuthStatus;
  apiOrigin: string;
  onlineTargetId: string | null;
};

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

function signedInState(): MutableState {
  return {
    identity: ACCOUNT,
    authStatus: DesktopAuthStatus.Authenticated,
    apiOrigin: ORIGIN_A,
    onlineTargetId: TARGET,
  };
}

test("the live hello-derived target always wins over a retained one", () => {
  const retained = createRetainedComputeTargetIdentity();
  retained.remember(ACCOUNT, ORIGIN_A, OTHER_TARGET);
  assert.equal(retained.resolve(ACCOUNT, ORIGIN_A, TARGET), TARGET);
});

test("a retained target survives the socket drop for the same account", () => {
  const state = signedInState();
  const adapter = adapterOver(state);

  adapter.remember({ targetId: TARGET });
  state.onlineTargetId = null;

  assert.equal(adapter.computeTargetId(), TARGET);
  assert.equal(adapter.isHttpReady(), true);
});

test("a retained target never outlives the account that owned it", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  state.onlineTargetId = null;

  for (const [label, identity] of [
    ["a different user", OTHER_ACCOUNT],
    // The org half matters on its own: the same human in a second org is a
    // different tenant, and `sameUserIdentity` exists so this cannot regress to
    // a user-id-only check.
    ["the same user in another org", SAME_USER_OTHER_ORG],
    ["signed out", null],
  ] as const) {
    state.identity = identity;
    assert.equal(
      adapter.computeTargetId(),
      null,
      `must not write under the previous account's target after ${label}`
    );
    assert.equal(adapter.isHttpReady(), false, `lane must be shut: ${label}`);
  }
});

test("ISS-8691 (davetho, #6351): an account switch never rides the previous account's LIVE target", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  // The ordinary online read, which is also what binds TARGET to this account.
  assert.equal(adapter.computeTargetId(), TARGET);

  // The socket stays UP and no new hello arrives — identity is hello-derived, so
  // an account switch is precisely the event that produces no fresh target.
  for (const [label, identity] of [
    ["a different user", OTHER_ACCOUNT],
    ["the same user in another org", SAME_USER_OTHER_ORG],
  ] as const) {
    state.identity = identity;
    assert.equal(
      adapter.computeTargetId(),
      null,
      `must not name the previous account's live target after ${label}`
    );
    assert.equal(
      adapter.isHttpReady(),
      false,
      `the lane must be shut rather than earn a target_not_owned deferral per batch: ${label}`
    );
  }
});

test("ISS-8691 (davetho, #6351): a hello that landed before sign-in is adopted at auth and survives the next drop", () => {
  // The socket is already up, but no first-party session exists yet — it
  // authenticates on its own credential, so this ordering is ordinary at launch.
  const state: MutableState = {
    identity: null,
    authStatus: DesktopAuthStatus.SignedOut,
    apiOrigin: ORIGIN_A,
    onlineTargetId: TARGET,
  };
  const adapter = adapterOver(state);
  // The eager bind at the online transition has no one to attribute the id to.
  adapter.remember({ targetId: TARGET });

  state.identity = ACCOUNT;
  state.authStatus = DesktopAuthStatus.Authenticated;
  // The lane's next read is what adopts it; no second hello is involved.
  assert.equal(adapter.computeTargetId(), TARGET);

  state.onlineTargetId = null;
  assert.equal(
    adapter.computeTargetId(),
    TARGET,
    "a connection that was never bound must not dark the lane on its first drop"
  );
  assert.equal(adapter.isHttpReady(), true);
});

test("forget() drops the retained target, and an unattributable one is never handed out", () => {
  const state = signedInState();
  const adapter = adapterOver(state);

  adapter.remember({ targetId: TARGET });
  state.onlineTargetId = null;
  adapter.forget();
  assert.equal(adapter.computeTargetId(), null, "forget() must clear it");

  // A hello that lands while signed out has no account to bind to. ISS-8702
  // records it anyway — the record is what makes the id recognisable as this
  // origin's later — but it is never RETURNED as a retained target, which is the
  // guarantee: an id we cannot attribute is an id we must not send under.
  state.identity = null;
  adapter.remember({ targetId: OTHER_TARGET });
  state.identity = ACCOUNT;
  assert.equal(adapter.computeTargetId(), null);
});

test("ISS-8691: a signed-out re-hello must not ERASE the account a target is bound to", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });

  // Sign out with the socket still up: it authenticates on its own credential,
  // so the relay can drop and re-hello with the SAME target while `getIdentity()`
  // is null. Recording the origin there is fine; forgetting who owns the id is
  // not — that is what lets the next account adopt it.
  state.identity = null;
  adapter.remember({ targetId: TARGET });

  state.identity = OTHER_ACCOUNT;
  assert.equal(
    adapter.computeTargetId(),
    null,
    "the previous account's target must still be refused after a signed-out re-hello"
  );
  assert.equal(adapter.isHttpReady(), false);

  // Still the original owner's, and still usable by them once the socket drops.
  state.identity = ACCOUNT;
  state.onlineTargetId = null;
  assert.equal(adapter.computeTargetId(), TARGET);
});

test("readiness still requires a live session, retained target or not", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  state.onlineTargetId = null;

  for (const authStatus of [
    DesktopAuthStatus.SignedOut,
    DesktopAuthStatus.Loading,
    DesktopAuthStatus.RefreshFailed,
  ]) {
    state.authStatus = authStatus;
    assert.equal(
      adapter.isHttpReady(),
      false,
      `${authStatus} must not enable the lane`
    );
  }
});

/**
 * Drive the real service to a settled state, returning the target ids the lane
 * addressed its batches to.
 */
async function drainWith(options: {
  isHttpReady: () => boolean;
  getSyncComputeTargetId: () => string | null;
}): Promise<string[]> {
  const source = new FakeSyncSource([
    makeSyncedSession("iss8691-session", "2026-08-31T13:00:00.000Z"),
  ]);
  const sentUnder: string[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: options.isHttpReady,
    getSource: () => source,
    getSyncComputeTargetId: options.getSyncComputeTargetId,
    // Mirrors the production send closure in `desktop-sync-lane-composition.ts`:
    // the lane resolves the target at send time and defers when it has none.
    sendBatch: () => {
      const computeTargetId = options.getSyncComputeTargetId();
      if (!computeTargetId) {
        return Promise.resolve({
          accepted: false as const,
          reason: DesktopAgentSessionsAckReason.TransportUnavailable,
        });
      }
      sentUnder.push(computeTargetId);
      return Promise.resolve({ accepted: true as const });
    },
  });
  service.start();
  for (let turn = 0; turn < DRAIN_TURNS && sentUnder.length === 0; turn++) {
    await pumpSyncDrainTurn();
  }
  service.stop();
  return sentUnder;
}

test("ISS-8691: the lane sends while the socket is offline, under the retained target", async () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  // The socket is down — the exact condition that used to stop the lane dead.
  state.onlineTargetId = null;

  const sentUnder = await drainWith({
    isHttpReady: () => adapter.isHttpReady(),
    getSyncComputeTargetId: () => adapter.computeTargetId(),
  });

  assert.ok(
    sentUnder.length > 0,
    "a queued session must reach the cloud while the socket is reconnecting"
  );

  // COUNTERFACTUAL: the pre-fix wiring, which is strict-online on both terms.
  // It must send nothing under identical conditions, or the assertion above is
  // proving the lane runs rather than proving this change is what makes it run.
  const strictOnline = await drainWith({
    isHttpReady: () => state.onlineTargetId !== null,
    getSyncComputeTargetId: () => state.onlineTargetId,
  });
  assert.equal(
    strictOnline.length,
    0,
    "strict-online readiness must be what this fix removes"
  );
});

test("ISS-8691: an account switch while offline stops the lane rather than sending under the old target", async () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  state.onlineTargetId = null;
  state.identity = OTHER_ACCOUNT;

  const sentUnder = await drainWith({
    isHttpReady: () => adapter.isHttpReady(),
    getSyncComputeTargetId: () => adapter.computeTargetId(),
  });

  assert.deepEqual(
    sentUnder,
    [],
    "a retained target must never carry one account's sessions under another"
  );
});

/**
 * The READ half of the same identity (whitlockk, #6351). The Sessions list keys its
 * pending-outbox lookup on a compute target too, so the moment the write side
 * gained a target the read side did not have, a batch this lane is still holding
 * stopped being looked up at all. ISS-9004 has since made a null target read as
 * UNKNOWN rather than as a proven-empty set, so that row now publishes no
 * cloud-sync claim instead of `synced` — the counterfactual below asserts the
 * outbox is never consulted, which is what this wiring is about, and pins the
 * post-ISS-9004 projection beside it.
 *
 * That is the FEA-4157 defect class `rebuild-sync-compute-target.ts` already
 * carries a note about, reached through a second door: not a handler that forgot
 * to pass a target, but two derivations of the same target disagreeing.
 */
async function listUnder(getSyncComputeTargetId: () => string | null): Promise<{
  outboxSourceKey: string | null;
  stateOf: (id: string) => string | undefined;
}> {
  const source = createFakeSource({
    cursorRows: [cursor("acked-session"), cursor("queued-session")],
    sessions: {
      "acked-session": session({ id: "acked-session" }),
      "queued-session": session({ id: "queued-session" }),
    },
    // Still enqueued, un-acked: the batch the lane is holding right now.
    pendingOutboxIds: ["queued-session"],
  });
  const response = await getSharedAgentSessions(
    source,
    { quality: "all" },
    // The production builder, so the test cannot disagree with the real read.
    buildSharedAgentSessionsListOptions({}, { getSyncComputeTargetId })
  );
  const byId = new Map(response.items.map((item) => [item.id, item]));
  return {
    outboxSourceKey:
      source.calls.find((call) => call.kind === "loadPendingOutboxIds")
        ?.sourceKey ?? null,
    stateOf: (id) => byId.get(id)?.cloudSyncState,
  };
}

test("ISS-8691: a batch queued under the retained target reads back as `pending`, not `synced`", async () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  // The socket is down and the lane keeps sending under the retained target —
  // the state the drain test above proves is now reachable.
  state.onlineTargetId = null;

  const retained = await listUnder(() => adapter.computeTargetId());
  assert.equal(
    retained.outboxSourceKey,
    buildAgentSessionSyncSourceKey(TARGET),
    "the list must read the outbox under the key the lane is enqueuing under"
  );
  assert.equal(retained.stateOf("queued-session"), "pending");
  assert.equal(retained.stateOf("acked-session"), "synced");

  // COUNTERFACTUAL: the strict-online derivation this change removes from the
  // dashboard bootstrap. Same offline moment, same un-acked row — the outbox is
  // never consulted and the row is published `synced`, which is the UI reporting
  // a batch as delivered while the lane still holds it.
  const strictOnline = await listUnder(() => state.onlineTargetId);
  assert.equal(
    strictOnline.outboxSourceKey,
    null,
    "the strict-online read must be the one that never consults the outbox"
  );
  assert.equal(
    strictOnline.stateOf("queued-session"),
    undefined,
    "an unconsulted outbox must claim nothing about a row it never read"
  );
  assert.equal(
    strictOnline.stateOf("acked-session"),
    undefined,
    "and it must not claim `synced` for the acked row either — it read neither"
  );
});

/** The dep name whose two production wirings must resolve to the same accessor. */
const SYNC_TARGET_DEP = "getSyncComputeTargetId";

/**
 * Every module that wires {@link SYNC_TARGET_DEP}, with the EXACT accessor each
 * one must delegate to.
 *
 * Both wirings lived in `app.ts` until ISS-8768 moved the sync-lane one into
 * `desktop-sync-lane-deps.ts` to bring the grandfathered file back under its
 * line ceiling. The guard follows its subject rather than settling for the
 * wiring that stayed: it scans both modules, and the per-site assertion below
 * still insists on BOTH, so relaxing this to whatever `app.ts` happens to hold
 * would retire half the guarantee silently.
 *
 * The receiver differs by module — `this` inside `DesktopApplication`, the
 * destructured port inside the builder — so each site pins its own accessor
 * EXACTLY. Matching them on the shared `sessionSyncIdentity.computeTargetId`
 * suffix instead would also accept a `computeTargetId` read off some unrelated
 * object, which is the very second derivation this guard exists to reject.
 */
const SYNC_TARGET_WIRING_SITES = [
  {
    label: "app.ts (dashboard bootstrap)",
    parse: parseAppModule,
    accessor: "this.sessionSyncIdentity.computeTargetId",
  },
  {
    label: "desktop-sync-lane-deps.ts (sync lanes)",
    parse: parseSyncLaneDepsModule,
    accessor: "sessionSyncIdentity.computeTargetId",
  },
] as const;

/**
 * `app.ts` statically imports `electron`, so no node test can drive it, and the
 * lane-deps builder is only ever called from it; this is the sanctioned AST
 * guard (see `test/support/app-module-ast.ts`). It covers the one thing the
 * behavior test above structurally cannot: WHICH accessor each production
 * wiring reaches for. Both sites already carry the name
 * `getSyncComputeTargetId`, so a second derivation of it is invisible to
 * typecheck and to every runnable suite — the read side was wired to
 * `onlineComputeTargetId()` for exactly that reason.
 */
test("ISS-8691 (whitlockk, #6351): every `getSyncComputeTargetId` wiring reaches the retained-aware accessor", () => {
  for (const site of SYNC_TARGET_WIRING_SITES) {
    const wirings = wiringsOf(site.parse(), SYNC_TARGET_DEP);
    // Per SITE, not a total across both. A total cannot see WHICH module
    // produced it, so two wirings left in one module would satisfy it while the
    // other had stopped wiring the dep at all — the exact shape that made this
    // guard's own subject relocate unnoticed until it went red.
    assert.ok(
      wirings.length >= 1,
      `expected a ${SYNC_TARGET_DEP} wiring in ${site.label}, found ${wirings.length}`
    );
    for (const accessor of wirings) {
      assert.equal(
        accessor,
        site.accessor,
        "a second derivation of the sync compute target lets the read and write sides disagree"
      );
    }
  }
});

/** Every call expression at or under `node`, outermost first. */
function callsIn(node: Node): CallExpression[] {
  const calls: CallExpression[] = [];
  const visit = (child: Node): void => {
    if (isCallExpression(child)) {
      calls.push(child);
    }
    forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

/** A callee's dotted path (`this.a.b`), or null when it is not a plain chain. */
function dottedName(node: Node): string | null {
  if (node.kind === SyntaxKind.ThisKeyword) {
    return "this";
  }
  if (isIdentifier(node)) {
    return node.text;
  }
  if (isPropertyAccessExpression(node)) {
    const receiver = dottedName(node.expression);
    return receiver ? `${receiver}.${node.name.text}` : null;
  }
  return null;
}

/** The accessor each `<depName>: () => …` at or under `root` delegates to. */
function wiringsOf(root: Node, depName: string): string[] {
  const accessors: string[] = [];
  const visit = (node: Node): void => {
    if (
      isPropertyAssignment(node) &&
      isIdentifier(node.name) &&
      node.name.text === depName
    ) {
      const [call] = callsIn(node.initializer);
      accessors.push(
        (call && dottedName(call.expression)) ?? "<not a plain delegation>"
      );
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return accessors;
}

/**
 * ISS-8702 — the apiOrigin half of the retained identity. Marisol, 2026-08-31:
 * "Retain identity as user + organization + apiOrigin + targetId. When apiOrigin
 * changes, invalidate the retained target ID and resolve/register a target
 * against the new origin; never present an ID minted by origin A to origin B."
 *
 * Two production states are modelled, and they are NOT the same window.
 * `apiOrigin = ORIGIN_B` with `onlineTargetId` still set is the synchronous
 * `agentSessionSync.refresh()` that `restartCloudSocket()` fires BEFORE
 * `cloudSocket.restart()` — brief, because `restart()` then reaches
 * `notifyStatus({ state: "idle" })` before its first await. `onlineTargetId =
 * null` is the settled state afterwards, and it is the one that lasts: until the
 * socket reconnects against the new origin, the retained id is all the lane has.
 * Both are why the origin has to travel with the id rather than be re-read here.
 */
test("ISS-8702: an id minted under origin A is never presented to origin B", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  assert.equal(
    adapter.computeTargetId(),
    TARGET,
    "the ordinary same-origin read"
  );

  state.apiOrigin = ORIGIN_B;
  assert.equal(
    adapter.computeTargetId(),
    null,
    "the stale live status still names origin A's target, and must not be offered to origin B"
  );
  assert.equal(adapter.isHttpReady(), false);

  // And with the socket down, where only the retained id is on offer.
  state.onlineTargetId = null;
  assert.equal(adapter.computeTargetId(), null);
  assert.equal(adapter.isHttpReady(), false);
});

test("ISS-8702: an origin change invalidates the retained id AND resolves a target against the new origin", async () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });

  state.apiOrigin = ORIGIN_B;
  assert.equal(
    adapter.computeTargetId(),
    null,
    "origin A's id must not survive the switch"
  );

  // The reconnect the origin change already triggered: a hello against origin B
  // mints a target there and binds it. This is the half that separates
  // invalidate-and-re-register from a bare refusal — a refusal alone leaves the
  // lane with no target at all, indefinitely.
  state.onlineTargetId = OTHER_TARGET;
  adapter.remember({ targetId: OTHER_TARGET });
  assert.equal(adapter.computeTargetId(), OTHER_TARGET);

  state.onlineTargetId = null;
  assert.equal(
    adapter.computeTargetId(),
    OTHER_TARGET,
    "the target registered against the new origin must be retained like any other"
  );
  assert.equal(adapter.isHttpReady(), true);

  // The consumer that makes re-registration matter rather than a bare refusal:
  // the list keys its outbox lookup on the same compute target. This asserts the
  // RECOVERED state only — that after re-registration the read side is back on a
  // real key and a queued batch reads `pending`. The refusal window itself is
  // NOT pinned here, and during it a null target makes the list publish an
  // un-acked row as `synced` (pre-existing on the account-switch arm of this
  // same resolver; the FEA-4157 class `rebuild-sync-compute-target.ts` notes).
  const listed = await listUnder(() => adapter.computeTargetId());
  assert.equal(
    listed.outboxSourceKey,
    buildAgentSessionSyncSourceKey(OTHER_TARGET),
    "the list must read the outbox under the target the lane is now enqueuing under"
  );
  assert.equal(listed.stateOf("queued-session"), "pending");
});

test("ISS-8702: the identity-null window keeps the lane alive and still enforces the origin", () => {
  // A hello before first-party auth: the account half of the key cannot be
  // computed, the origin half can — so only the account half defers.
  const state: MutableState = {
    identity: null,
    authStatus: DesktopAuthStatus.SignedOut,
    apiOrigin: ORIGIN_A,
    onlineTargetId: TARGET,
  };
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });

  assert.equal(
    adapter.computeTargetId(),
    TARGET,
    "an uncomputable account half must not dark the lane — this is the id it already sent under"
  );

  state.apiOrigin = ORIGIN_B;
  assert.equal(
    adapter.computeTargetId(),
    null,
    "the origin half needs no identity, so it is enforced in this window too"
  );

  // Back on the origin that minted it, now signed in: the ISS-8691 adoption
  // still runs, so the pre-auth connection survives its first drop.
  state.apiOrigin = ORIGIN_A;
  state.identity = ACCOUNT;
  state.authStatus = DesktopAuthStatus.Authenticated;
  assert.equal(adapter.computeTargetId(), TARGET);
  state.onlineTargetId = null;
  assert.equal(
    adapter.computeTargetId(),
    TARGET,
    "a connection bound before auth must still be adopted rather than darking the lane"
  );
  assert.equal(adapter.isHttpReady(), true);
});

test("ISS-8702: a different spelling of the same origin is not an environment switch", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  state.onlineTargetId = null;

  // Same environment, spelled the way a settings round-trip can leave it. A raw
  // string compare here would invalidate a perfectly good target and dark the
  // lane on a change that moved nothing, so the comparison is on the canonical
  // environment key both sides derive.
  state.apiOrigin = "HTTPS://API.ORIGIN-A.TEST/";
  assert.equal(adapter.computeTargetId(), TARGET);
  assert.equal(adapter.isHttpReady(), true);
});

test("ISS-8702: an origin that cannot be parsed is unknown, never a match", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });
  state.onlineTargetId = null;

  // `normalizeEnvironmentKey` records an unparseable origin as ABSENT, so two
  // different bad origins both key to null. Comparing absent-to-absent as equal
  // would disable this gate exactly where the environment cannot be named.
  for (const unparseable of ["", "api.origin-a.test", "://nope"]) {
    state.apiOrigin = unparseable;
    assert.equal(
      adapter.computeTargetId(),
      null,
      `an unnameable environment must not be handed origin A's target: ${JSON.stringify(unparseable)}`
    );
  }

  // An id minted while the origin was unnameable is not handed to a real one...
  state.apiOrigin = "";
  adapter.remember({ targetId: OTHER_TARGET });
  state.apiOrigin = ORIGIN_A;
  assert.equal(adapter.computeTargetId(), null);

  // ...and, the case that actually separates "absent" from "a value": BOTH sides
  // unnameable. Mint under one bad origin, resolve under a different one, and a
  // null-equals-null comparison hands the id straight over. Asserting only the
  // arms above leaves that mutation alive.
  state.apiOrigin = "";
  adapter.remember({ targetId: OTHER_TARGET });
  state.apiOrigin = "api.origin-a.test";
  assert.equal(
    adapter.computeTargetId(),
    null,
    "two different unnameable origins are not the same environment"
  );
});

test("ISS-8702 (whitlockk, #6527): a re-ack of the same id is not a registration against the new origin", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET });

  // Editing ONLY the API Origin of the active gateway profile
  // (`gateway-profile-connection-fields.tsx`) saves, then restarts the cloud
  // socket — against the unchanged `relayOrigin`. The relay resolves the target
  // against its own environment, so the hello re-acks the very same id. Stamping
  // origin B on that ack is exactly "an ID minted by origin A presented to
  // origin B", now labelled safe.
  //
  // Both `remember` calls here state no origin, which is deliberate: this pins
  // the heuristic ISS-9081's `mintingApiOrigin` falls back to, so the case keeps
  // covering an older relay after that field exists.
  state.apiOrigin = ORIGIN_B;
  adapter.remember({ targetId: TARGET });

  assert.equal(
    adapter.computeTargetId(),
    null,
    "a re-acked id must keep the origin that minted it, not take the current one"
  );
  assert.equal(adapter.isHttpReady(), false);

  // And once the socket settles, where only the retained id is on offer.
  state.onlineTargetId = null;
  assert.equal(adapter.computeTargetId(), null);

  // Repointing the relay at origin B mints a target there — a different id,
  // because the row lives in that environment's database — and THAT is what
  // re-registers. The guard above must not have cost the re-registration path.
  state.onlineTargetId = OTHER_TARGET;
  adapter.remember({ targetId: OTHER_TARGET });
  state.onlineTargetId = null;
  assert.equal(adapter.computeTargetId(), OTHER_TARGET);
  assert.equal(adapter.isHttpReady(), true);
});

/** The object literal `app.ts` builds the session-sync identity adapter from. */
function sessionSyncIdentitySources(sourceFile: SourceFile): Node {
  const construction = callsIn(sourceFile).find(
    (call) => dottedName(call.expression) === "createSessionSyncIdentityAdapter"
  );
  const sources = construction?.arguments[0];
  if (!sources) {
    throw new Error(
      "app.ts must construct the session-sync identity adapter from an explicit sources object"
    );
  }
  return sources;
}

/**
 * ISS-8702: the origin half of the key is only enforceable if the LIVE settings
 * value reaches the adapter. Typecheck forces the field to exist but not that it
 * reads settings — a constant satisfies the compiler and retires the gate
 * silently — and `app.ts` statically imports `electron`, so no node test can
 * drive the wiring. Same sanctioned AST guard as the one above.
 */
test("ISS-8702: the session-sync identity adapter is wired to the live apiOrigin", () => {
  assert.deepEqual(
    wiringsOf(sessionSyncIdentitySources(parseAppModule()), "getApiOrigin"),
    ["this.settingsStore.getApiOrigin"]
  );
});

/**
 * ISS-9081 — the ack states its minting origin, so adoption is guarded on a
 * fact instead of an inference.
 *
 * ISS-8702 recorded the origin a target was minted under, but the ack carried
 * none, so `remember` had to stamp the origin the desktop happened to be
 * pointed at. Those two disagree in production: the relay resolves the target
 * against its OWN `CLOSEDLOOP_API_URL` while `relayOrigin` and `apiOrigin` are
 * separate desktop settings. `resolveRelayHelloTarget` also falls through from
 * `updateOwned` to `register()` on any miss — a deleted row, an org switch, a
 * changed machineName — so a re-register INSIDE origin A hands back a fresh
 * A-minted id, which the different-id heuristic then stamped as B's.
 *
 * The refusal these cases pin is deliberately NOT "refuse while the recorded
 * origin differs". That guard was available before this ticket and is wrong: it
 * also refuses the legitimate profile that moves `relayOrigin` and `apiOrigin`
 * together, which mints a genuine B-owned target and must be adopted. The
 * separator is the STATEMENT, and its absence must change nothing at all — so
 * the refusing case and the adopting case are pinned as a pair, and a build
 * that never refuses fails the first while a build that always refuses fails
 * the rest.
 */
test("ISS-9081: an id the ack attributes to origin A is not adopted under origin B", () => {
  const state = signedInState();
  state.apiOrigin = ORIGIN_B;
  state.onlineTargetId = OTHER_TARGET;
  const adapter = adapterOver(state);

  // A re-register inside origin A: an id this desktop has never recorded, so
  // the different-id heuristic reads it as a registration against the origin we
  // are pointed at. The ack contradicts that.
  adapter.remember({ targetId: OTHER_TARGET, mintingApiOrigin: ORIGIN_A });

  assert.equal(
    adapter.computeTargetId(),
    null,
    "an id the relay says origin A minted must not be presented to origin B"
  );
  assert.equal(adapter.isHttpReady(), false);

  state.onlineTargetId = null;
  assert.equal(
    adapter.computeTargetId(),
    null,
    "and once the socket settles, where only the retained id is on offer"
  );
});

test("ISS-9081: an ack that states no origin is adopted and stamped exactly as before", () => {
  const state = signedInState();
  state.apiOrigin = ORIGIN_B;
  state.onlineTargetId = OTHER_TARGET;
  const adapter = adapterOver(state);

  // Both version-skew directions reach this one call shape: a relay on an older
  // build never sends the field, and a desktop on an older build drops it at
  // the parse. Either way `remember` is handed no statement.
  adapter.remember({ targetId: OTHER_TARGET });

  state.onlineTargetId = null;
  assert.equal(
    adapter.computeTargetId(),
    OTHER_TARGET,
    "no statement must adopt exactly as it did before the field existed"
  );
  assert.equal(adapter.isHttpReady(), true);

  // Adopted AND stamped with the current origin. Asserting only that adoption
  // happened would also pass on a build that recorded no origin at all, which
  // is a silently retired ISS-8702 gate rather than preserved behaviour.
  state.apiOrigin = ORIGIN_A;
  assert.equal(
    adapter.computeTargetId(),
    null,
    "an id stamped with origin B must still be refused to origin A"
  );
  state.apiOrigin = ORIGIN_B;
  assert.equal(adapter.computeTargetId(), OTHER_TARGET);
});

test("ISS-9081: a profile that moves both origins mints a B-owned target and adopts it", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  adapter.remember({ targetId: TARGET, mintingApiOrigin: ORIGIN_A });
  assert.equal(
    adapter.computeTargetId(),
    TARGET,
    "the ordinary same-origin read"
  );

  state.apiOrigin = ORIGIN_B;
  assert.equal(
    adapter.computeTargetId(),
    null,
    "origin A's id must not survive the switch"
  );

  // `relayOrigin` moved with it, so the relay now in front of us is origin B's:
  // it mints a target B owns and says so. This is the path a bare
  // refuse-on-mismatch guard closes forever, leaving the lane with no target at
  // all — it is ISS-8702's counterfactual 2, now carrying a stated origin.
  state.onlineTargetId = OTHER_TARGET;
  adapter.remember({ targetId: OTHER_TARGET, mintingApiOrigin: ORIGIN_B });
  assert.equal(adapter.computeTargetId(), OTHER_TARGET);

  state.onlineTargetId = null;
  assert.equal(
    adapter.computeTargetId(),
    OTHER_TARGET,
    "a target the ack attributes to the origin we are talking to must be retained like any other"
  );
  assert.equal(adapter.isHttpReady(), true);
});

test("ISS-9081: a stated origin that cannot be parsed degrades to absent, never to a refusal", () => {
  const state = signedInState();
  state.apiOrigin = ORIGIN_B;
  state.onlineTargetId = OTHER_TARGET;
  const adapter = adapterOver(state);

  // `normalizeEnvironmentKey` records an unnameable origin as ABSENT, and an
  // absent key is "elsewhere" to every origin — so recording one would dark the
  // lane indefinitely because a peer spelled a field oddly. The cross-repo rule
  // forbids blocking a core flow on a peer's version, so an unusable statement
  // is no statement.
  adapter.remember({
    targetId: OTHER_TARGET,
    mintingApiOrigin: "api.origin-a.test",
  });

  state.onlineTargetId = null;
  assert.equal(
    adapter.computeTargetId(),
    OTHER_TARGET,
    "an unusable statement must fall back to today's behaviour, not refuse"
  );
  assert.equal(adapter.isHttpReady(), true);
});

test("ISS-9081: a stated origin supersedes the re-ack heuristic that stood in for it", () => {
  const state = signedInState();
  state.apiOrigin = ORIGIN_B;
  const adapter = adapterOver(state);

  // An older relay acked this id and stated nothing, so ISS-8702 stamped the
  // origin we are pointed at.
  adapter.remember({ targetId: TARGET });
  assert.equal(adapter.computeTargetId(), TARGET);

  // That relay is upgraded and re-acks the SAME id, now naming the environment
  // that actually holds the row. ISS-8702's re-ack branch deliberately KEEPS
  // the recorded origin on a same-id re-ack — but that branch exists only
  // because the ack could not speak, so a statement has to outrank it.
  adapter.remember({ targetId: TARGET, mintingApiOrigin: ORIGIN_A });
  assert.equal(
    adapter.computeTargetId(),
    null,
    "a re-ack that names its origin corrects the record rather than preserving a guess"
  );
});

/**
 * ISS-9081: the wire-to-guard chain, driven end to end.
 *
 * The cases above call `remember` directly, so every one of them stays green if
 * the field never survives the parse or never reaches the online status. This
 * one emits a real `desktop.hello.ack` frame at the production handler and
 * mirrors `app.ts`'s online branch, so the field name on the wire is pinned by
 * a literal written here rather than by the type under test.
 */
test("ISS-9081: a minting origin stated on the wire reaches the adoption guard", () => {
  const adopted = (frame: Record<string, unknown>): string | null =>
    adoptedFromHelloAckFrame(frame, ORIGIN_B, ACCOUNT);

  assert.equal(
    adopted({ computeTargetId: OTHER_TARGET, mintingApiOrigin: ORIGIN_A }),
    null,
    "the origin stated on the frame must survive the parse and the status hop"
  );
  assert.equal(
    adopted({ computeTargetId: OTHER_TARGET }),
    OTHER_TARGET,
    "and the very same frame without it must still be adopted"
  );
});

test("ISS-9081: a stated origin corrects a stamp the pre-remember adoption already made", () => {
  const state = signedInState();
  state.apiOrigin = ORIGIN_B;
  state.onlineTargetId = OTHER_TARGET;
  const adapter = adapterOver(state);

  // `onCloudSocketStatus` refreshes both sync lanes BEFORE it reaches the
  // `remember` in its online branch, so one resolve per online transition can
  // reach a brand-new id ahead of the ack's statement. That read has no ack, so
  // the ISS-8691 adoption stamps the origin we are pointed at.
  assert.equal(
    adapter.computeTargetId(),
    OTHER_TARGET,
    "the pre-remember read adopts the live id under the current origin"
  );

  // `remember` then lands carrying the statement, and it must OVERRULE that
  // stamp rather than read the id as already-attributed — the record it is
  // correcting is the one the adoption just wrote, so a re-ack branch that won
  // here would make the guard bypassable for the life of the connection by a
  // single earlier read.
  adapter.remember({ targetId: OTHER_TARGET, mintingApiOrigin: ORIGIN_A });
  assert.equal(
    adapter.computeTargetId(),
    null,
    "the statement must correct an adoption that beat it, not defer to it"
  );

  state.onlineTargetId = null;
  assert.equal(adapter.computeTargetId(), null);
});

/**
 * ISS-9164 (whitlockk, #6867) — what the UPDATER feed may be stamped with.
 *
 * `computeTargetId` keeps returning the live hello-derived id through the
 * identity-null windows on purpose: the socket authenticates on its own
 * credential, so a hello lands before first-party auth and the sync lane must
 * not dark on it. The updater feed cannot take that trade. It is the one
 * first-party route with no session behind it — a packaged, signed build cannot
 * redirect its baked-in feed URL — so an id stamped there is scoped by nothing,
 * and stamping it on every poll of a signed-out install outlives the session it
 * belonged to.
 *
 * The two accessors are asserted TOGETHER, in that order. A build that darked
 * the sync lane's read to buy this would fail the first assertion, and that is
 * the regression the fix must not be allowed to become.
 */
test("ISS-9164 (whitlockk, #6867): the auth-aware accessor drops a live target once the account is gone", () => {
  const state = signedInState();
  const adapter = adapterOver(state);
  assert.equal(adapter.authenticatedComputeTargetId(), TARGET);

  state.identity = null;
  state.authStatus = DesktopAuthStatus.SignedOut;

  assert.equal(
    adapter.computeTargetId(),
    TARGET,
    "the sync lane's read must still hold the live id through the identity-null window"
  );
  assert.equal(
    adapter.authenticatedComputeTargetId(),
    null,
    "a signed-out install must not stamp its prior target on the unauthenticated updater feed"
  );
});

/** The deps object `app.ts` installs the desktop update lane from. */
function desktopUpdateWiringDeps(sourceFile: SourceFile): Node {
  const start = callsIn(sourceFile).find(
    (call) => dottedName(call.expression) === "installDesktopUpdateLane"
  );
  const deps = start?.arguments[0];
  if (!deps) {
    throw new Error(
      "app.ts must install the desktop update lane from an explicit deps object"
    );
  }
  return deps;
}

/**
 * The wiring half, and it needs the sanctioned AST guard for the same reason its
 * ISS-8691 sibling above does: `app.ts` statically imports `electron`, so no node
 * test can drive it, and both accessors satisfy `() => string | null`, so
 * swapping back to `computeTargetId` is invisible to typecheck and to every
 * runnable suite. Scoped to the `installDesktopUpdateLane` argument because two
 * OTHER `getComputeTargetId` wirings in `app.ts` correctly read
 * `onlineComputeTargetId`.
 *
 * Asserted across the hop, not just at the wiring (#6867). Since the gateway
 * action and the renderer IPC were routed through the same stamping seam, all
 * three read one named accessor — so pinning only the wiring would let that one
 * accessor be re-pointed at `computeTargetId` and re-open this for every seam at
 * once, with this assertion still green.
 */
test("ISS-9164 (whitlockk, #6867): the updater lane is wired to the auth-aware accessor", () => {
  const sourceFile = parseAppModule();

  assert.deepEqual(
    wiringsOf(desktopUpdateWiringDeps(sourceFile), "getComputeTargetId"),
    ["this.updaterComputeTargetId"]
  );
  assert.deepEqual(
    callsIn(appMethodBody(sourceFile, "updaterComputeTargetId")).map((call) =>
      dottedName(call.expression)
    ),
    ["this.sessionSyncIdentity.authenticatedComputeTargetId"]
  );
});

/** The body of an `app.ts` method, by name — the shared accessors live there. */
function appMethodBody(sourceFile: SourceFile, name: string): Node {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (
      !found &&
      isMethodDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.body ?? node;
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  if (!found) {
    throw new Error(`app.ts declares no ${name}() method`);
  }
  return found;
}
