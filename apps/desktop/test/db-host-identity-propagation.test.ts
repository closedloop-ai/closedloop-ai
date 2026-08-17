/**
 * @file db-host-identity-propagation.test.ts
 * @description ISS-6243 — the signed-in identity must actually REACH the db-host
 * child, and must keep reaching it as it changes.
 *
 * `DbHostClient.setUserIdentity` shipped with no production caller. The child's
 * only identity came from the Init snapshot, and on a cold start that snapshot
 * is `null` BY CONSTRUCTION: the identity resolver returns null on a cache miss
 * and warms `/me` in the background. So the child held null for its whole
 * lifetime and every session writer stamped a null owner — the better
 * explanation for `0 of 2970` owned sessions than the missing INSERT columns
 * alone, because it starves the live-hook path identically.
 *
 * These legs drive the REAL `createAgentDashboardDbHostLifecycle` over a fake
 * forked child and assert on the messages the production client actually posts.
 * That shape is deliberate: the sibling ISS-6168 review caught tests that called
 * the helper directly and stayed green when the boot call site was deleted.
 * Deleting the publisher wiring in the lifecycle makes every leg below fail,
 * because nothing else in the process ever posts `set-user-identity`.
 */
import assert from "node:assert/strict";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  mock,
  test,
} from "node:test";
import type { createAgentDashboardDbHostLifecycle as CreateLifecycle } from "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostUserIdentity } from "../src/main/database/db-host/db-host-protocol.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";

/** The pre-open zombie reap shells out to `lsof`; give each boot real room. */
const LIFECYCLE_BOOT_TIMEOUT_MS = 30_000;
/** Bound for {@link waitFor} — inside the boot timeout so it reports first. */
const WAIT_TIMEOUT_MS = 20_000;

const ALICE: DbHostUserIdentity = {
  userId: "user_alice",
  organizationId: "org_one",
};
/** Same human, different org — an org switch, and a DIFFERENT identity. */
const ALICE_IN_OTHER_ORG: DbHostUserIdentity = {
  userId: "user_alice",
  organizationId: "org_two",
};

type PostedMessage = {
  kind: string;
  id?: number;
  identity?: DbHostUserIdentity;
  options?: { identity?: DbHostUserIdentity };
};

/**
 * Poll until `predicate` holds, so a real async step is awaited rather than
 * guessed at.
 *
 * FEA-2399: BOUNDED AND FAIL-LOUD. Exhausting the budget throws, so a signal
 * that never arrives surfaces as an explicit timeout naming what was awaited,
 * never as a silent fall-through that then asserts a stale value.
 */
async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${label}`
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A fake forked db-host child that captures the client's listeners, so a test
 * can complete the Init handshake and then read back exactly what the
 * production client posted.
 */
function makeFakeChild() {
  const posted: PostedMessage[] = [];
  let messageListener: DbHostChildMessageListener | undefined;
  let exitListener: DbHostChildExitListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "exit") {
        exitListener = args[1];
      } else {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: PostedMessage) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    posted,
    /** Every identity push the client has made so far, oldest first. */
    identityPushes(): DbHostUserIdentity[] {
      return posted
        .filter((m) => m.kind === DbHostRequestKind.SetUserIdentity)
        .map((m) => m.identity ?? null);
    },
    /** The identity the Init message carried, if Init has been posted. */
    initIdentity(): DbHostUserIdentity | undefined {
      return posted.find((m) => m.kind === DbHostRequestKind.Init)?.options
        ?.identity;
    },
    /** Complete the pending init reply so the lifecycle's `ready` resolves. */
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
    /** Acknowledge the Close request so `close()` never waits out its budget. */
    acknowledgeClose() {
      const closeId = posted.find(
        (m) => m.kind === DbHostRequestKind.Close
      )?.id;
      if (closeId !== undefined) {
        messageListener?.({
          kind: DbHostResponseKind.Result,
          id: closeId,
          ok: true,
        });
      }
    },
    exit(code: number | null) {
      exitListener?.(code);
    },
  };
}

/**
 * A stand-in for the production identity sources: one live accessor plus the
 * subscription the runtime options declare. Production composes the credential
 * store and the `/me` resolver into exactly this pair of functions.
 */
function makeIdentitySource(initial: DbHostUserIdentity) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getUserIdentity: () => current,
    subscribeUserIdentityChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Model a sign-in, sign-out, or org switch: change, then announce. */
    change(next: DbHostUserIdentity) {
      current = next;
      for (const listener of listeners) {
        listener();
      }
    },
    /**
     * Change the value WITHOUT announcing it — the resolver warming inside the
     * `dbHost.start` → Ready window, where the notification is consumed before
     * the child is live and only the post-Ready reconcile can still catch it.
     */
    changeSilently(next: DbHostUserIdentity) {
      current = next;
    },
    /** Announce without changing — the redundant-notification case. */
    announce() {
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

function runtimeOptions(
  userDataPath: string,
  identitySource: ReturnType<typeof makeIdentitySource>
): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender: () => false,
    userDataPath,
    getUserIdentity: identitySource.getUserIdentity,
    subscribeUserIdentityChanged: identitySource.subscribeUserIdentityChanged,
  } as unknown as AgentDashboardDesignSystemRuntimeOptions;
}

/** Build the REAL lifecycle over a fake child and run it to a live db host. */
async function startLifecycle(
  createAgentDashboardDbHostLifecycle: typeof CreateLifecycle,
  userDataPath: string,
  initialIdentity: DbHostUserIdentity
) {
  const identity = makeIdentitySource(initialIdentity);
  const children = [makeFakeChild(), makeFakeChild()];
  const child = children[0];
  let spawnCount = 0;
  const lifecycle = createAgentDashboardDbHostLifecycle({
    options: runtimeOptions(userDataPath, identity),
    log: () => undefined,
    getPackScanCoordinator: () => null,
    getCatalogCoordinator: () => null,
    fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
  });

  // The pre-open zombie reap is a real async step in front of start(); poll for
  // the Init the client posts once it completes rather than guessing a delay.
  await waitFor("the db host to post Init", () => child.posted.length > 0);
  child.ready();
  await lifecycle.ready;

  // `DbHostClient.spawn` re-asserts a non-null identity once the child reports
  // ready (the restart path, which also runs on the first spawn), and it does so
  // before `ready` resolves. That push is pre-existing and says nothing about
  // this change, so the legs below assert on what is published AFTER boot.
  const bootPushes = child.identityPushes().length;

  return {
    lifecycle,
    child,
    children,
    identity,
    /** Identity pushes made after the db host came up, oldest first. */
    pushesAfterBoot: () => child.identityPushes().slice(bootPushes),
  };
}

describe("db-host user identity propagation (ISS-6243)", () => {
  let electronMock: ElectronModuleMock;
  let createLifecycle: typeof CreateLifecycle;

  before(async () => {
    // `agent-dashboard-runtime-paths.ts` does `import { app } from "electron"`
    // at module scope, which throws under `tsx --test` against the real
    // entrypoint (a path string). Redirect the specifier, then import the
    // lifecycle dynamically — the ISS-4845 mechanism.
    electronMock = registerElectronModuleMock();
    ({ createAgentDashboardDbHostLifecycle: createLifecycle } = await import(
      "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js"
    ));
  });

  after(() => {
    electronMock.deregister();
  });

  test("an identity resolved after a cold start reaches the child", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    // Cold start: the resolver has nothing cached and is warming `/me`, so the
    // boot snapshot is null. This is the state EVERY first launch is in.
    const { child, identity, pushesAfterBoot } = await startLifecycle(
      createLifecycle,
      "/tmp/iss-6243-cold-start",
      null
    );
    assert.equal(
      child.initIdentity(),
      null,
      "the Init snapshot is null on a cold start — that is the premise"
    );
    assert.deepEqual(
      pushesAfterBoot(),
      [],
      "nothing is pushed while the identity is genuinely unknown"
    );

    // The background `/me` lands and the resolver announces the transition.
    identity.change(ALICE);

    assert.deepEqual(
      pushesAfterBoot(),
      [ALICE],
      "the resolved identity must reach the child, or every session it writes stamps a null owner"
    );
  });

  test("an unchanged identity is not re-pushed", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const { identity, pushesAfterBoot } = await startLifecycle(
      createLifecycle,
      "/tmp/iss-6243-unchanged",
      ALICE
    );
    assert.deepEqual(
      pushesAfterBoot(),
      [],
      "the Init snapshot already carried this identity"
    );

    identity.announce();
    identity.announce();

    assert.deepEqual(
      pushesAfterBoot(),
      [],
      "a notification that does not change the pair must produce no traffic"
    );
  });

  test("signing out pushes null rather than leaving the previous user in place", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const { identity, pushesAfterBoot } = await startLifecycle(
      createLifecycle,
      "/tmp/iss-6243-sign-out",
      ALICE
    );

    identity.change(null);

    assert.deepEqual(
      pushesAfterBoot(),
      [null],
      "a stale identity is worse than none — it attributes sessions to the wrong person"
    );
  });

  test("an org switch is a change even when the user id is identical", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const { identity, pushesAfterBoot } = await startLifecycle(
      createLifecycle,
      "/tmp/iss-6243-org-switch",
      ALICE
    );

    identity.change(ALICE_IN_OTHER_ORG);

    assert.deepEqual(
      pushesAfterBoot(),
      [ALICE_IN_OTHER_ORG],
      "the identity is the (userId, organizationId) PAIR, not the user id"
    );
  });

  test("closing releases the subscription and stops publishing", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const { lifecycle, child, identity, pushesAfterBoot } =
      await startLifecycle(createLifecycle, "/tmp/iss-6243-teardown", ALICE);
    assert.equal(identity.listenerCount(), 1);

    const closing = lifecycle.close();
    await waitFor("the db host to post Close", () =>
      child.posted.some((m) => m.kind === DbHostRequestKind.Close)
    );
    child.acknowledgeClose();
    await closing;

    assert.equal(
      identity.listenerCount(),
      0,
      "the identity subscription must not outlive the db host it feeds"
    );

    identity.change(null);
    assert.deepEqual(
      pushesAfterBoot(),
      [],
      "a sign-out landing after teardown must not push into a closed client"
    );
  });

  describe("across an unexpected child restart", () => {
    beforeEach(() => {
      // The restart ladder arms a backoff timer; drive it deterministically
      // instead of waiting out a real backoff.
      mock.timers.enable({ apis: ["setTimeout"] });
    });

    afterEach(() => {
      mock.timers.reset();
    });

    test("a replacement child does not resurrect a signed-out identity", {
      timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
    }, async () => {
      // Boot signed in, then sign out. The db-host client re-sends its
      // RETAINED init options to a replacement child, and its post-Ready
      // re-assert only fires for a non-null identity — so a stale snapshot
      // would hand the fresh child the previous user and stamp their id on
      // every session it creates. This is the "stale is worse than null" case.
      const { children, identity } = await startLifecycle(
        createLifecycle,
        "/tmp/iss-6243-restart",
        ALICE
      );
      identity.change(null);

      children[0].exit(1);
      mock.timers.tick(60_000);
      await waitFor(
        "the replacement child to post Init",
        () => children[1].posted.length > 0
      );
      children[1].ready();

      assert.equal(
        children[1].initIdentity(),
        null,
        "the replacement child must come up signed out, not as the previous user"
      );
      assert.deepEqual(
        children[1].identityPushes(),
        [],
        "and nothing may re-assert the retired identity onto it"
      );
    });

    // Review thread (chatgpt-codex-connector, PR #4964): `scheduleRestart()`
    // captured `this.initOptions` when the ladder was ARMED. A sign-out during
    // the backoff replaced that field, but the attempt still forked from the
    // captured object — so the replacement child opened as the previous user,
    // and the post-Ready re-assert (gated on a non-null identity) skipped the
    // correction on exactly that boot.
    test("a sign-out DURING the restart backoff reaches the replacement child", {
      timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
    }, async () => {
      const { children, identity } = await startLifecycle(
        createLifecycle,
        "/tmp/iss-6243-restart-backoff-signout",
        ALICE
      );

      // Crash FIRST — this is what arms the ladder and captures the options.
      children[0].exit(1);
      // Only then does the user sign out. There is no child to post into at
      // this point, so the retained options are the only carrier.
      identity.change(null);

      mock.timers.tick(60_000);
      await waitFor(
        "the replacement child to post Init",
        () => children[1].posted.length > 0
      );
      children[1].ready();

      assert.equal(
        children[1].initIdentity(),
        null,
        "the replacement must open signed out, not from the snapshot taken before the sign-out"
      );
      assert.deepEqual(
        children[1].identityPushes(),
        [],
        "and nothing may re-assert the retired identity onto it"
      );
    });
  });

  // ISS-6168's load-bearing subtlety, carried forward onto the publisher that
  // replaced its poll: the reconcile baseline is the identity the child actually
  // OPENED with, never a read taken at reconcile time. The resolver can warm
  // between `dbHost.start` and Ready — a baseline sampled at Ready would already
  // be ALICE, dedupe, and skip the push on exactly the boots where it landed in
  // that window, leaving the child on the null it opened with.
  test("an identity that resolves INSIDE the start-to-ready window still reaches the child", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const identity = makeIdentitySource(null);
    const child = makeFakeChild();
    const lifecycle = createLifecycle({
      options: runtimeOptions("/tmp/iss-6243-warm-in-window", identity),
      log: () => undefined,
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      fork: () => child.child,
    });

    await waitFor("the db host to post Init", () => child.posted.length > 0);
    assert.equal(child.initIdentity(), null, "the child opened signed out");

    // `/me` lands here — after the Init snapshot was taken, before Ready.
    identity.changeSilently(ALICE);
    child.ready();
    await lifecycle.ready;

    assert.deepEqual(
      child.identityPushes(),
      [ALICE],
      "the reconcile must measure against what the child OPENED with, not against its own read"
    );
  });

  // Review thread (wongk, PR #4964): when `ready` rejects, runtime creation
  // throws before any close handle reaches the caller, so `close()` is never
  // called. The subscription would then stay attached to the credential store
  // and the `/me` resolver for the rest of the process lifetime.
  test("a db host that fails to start releases its identity subscription", async () => {
    const identity = makeIdentitySource(ALICE);
    const lifecycle = createLifecycle({
      options: runtimeOptions("/tmp/iss-6243-start-failure", identity),
      log: () => undefined,
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      fork: () => {
        throw new Error("fork failed");
      },
    });

    await assert.rejects(lifecycle.ready);

    assert.equal(
      identity.listenerCount(),
      0,
      "a start failure must not leak the subscription for the process lifetime"
    );
  });
});
