/**
 * @file session-owner-claim-retry.test.ts
 * @description ISS-6168 (PR #4947 review, wongk + chatgpt-codex-connector): the
 * two halves of the post-open owner claim that no DB-level test can see.
 *
 * 1. `createSessionOwnerClaimTracker` — the db-host worker's retry policy. The
 *    reviewed defect was recording the identity transition BEFORE the async claim
 *    resolved while the catch swallowed the failure: one transient rejection then
 *    matched the suppression key on every later post and the corpus stayed
 *    unattributed for the life of the worker. The mutation these tests exist to
 *    fail under is "mark the identity before/regardless of the outcome".
 *
 * 2. `createAgentDashboardDbHostLifecycle` — that main actually PUSHES a
 *    late-resolving identity into the db host. `DbHostClient.setUserIdentity` had
 *    no production caller at all, so the child kept the null snapshot it opened
 *    with, every writer routed through `buildSessionIdentityInsert` wrote a NULL
 *    owner, and the boot claim had nothing to stamp — the receiving half was
 *    unreachable scaffolding. This drives the REAL lifecycle over a fake child
 *    and asserts the `SetUserIdentity` request reaches it.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { createAgentDashboardDbHostLifecycle as CreateLifecycle } from "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
  type DbHostUserIdentity,
} from "../src/main/database/db-host/db-host-protocol.js";
import { createSessionOwnerClaimTracker } from "../src/main/database/db-host/session-owner-claim-tracker.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";

const SIGNED_IN: DbHostUserIdentity = {
  userId: "u-mike",
  organizationId: "org-closedloop",
};
/** The pre-open zombie reap shells out to `lsof`; give the boot leg real room. */
const LIFECYCLE_BOOT_TIMEOUT_MS = 60_000;
/** Poll cadence for {@link waitFor} — short enough to keep the suite quick. */
const WAIT_POLL_INTERVAL_MS = 25;

async function drainMicrotasks(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

describe("ISS-6168 db-host owner-claim retry policy", () => {
  test("a rejected claim stays retry-eligible for the same identity", async () => {
    const attempts: DbHostUserIdentity[] = [];
    const logs: string[] = [];
    let failNext = true;
    const tracker = createSessionOwnerClaimTracker({
      claim: (identity) => {
        attempts.push(identity);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("write queue evicted the claim"));
        }
        return Promise.resolve({ claimed: 3 });
      },
      log: (message) => logs.push(message),
    });

    tracker.onIdentity(SIGNED_IN);
    await drainMicrotasks();
    assert.equal(attempts.length, 1);
    assert.ok(
      logs.some((line) => line.includes("claim failed")),
      "the failure must be reported through the worker log channel, not swallowed"
    );

    // Main re-posts the SAME cached identity. Before the fix this was suppressed
    // and the corpus stayed unattributed until the next app restart.
    tracker.onIdentity(SIGNED_IN);
    await drainMicrotasks();
    assert.equal(attempts.length, 2, "the same identity must be retried");
    assert.ok(
      logs.some((line) => line.includes("attributed 3")),
      "the successful retry reports what it repaired"
    );

    // Settled now — a third post must not re-scan the corpus.
    tracker.onIdentity(SIGNED_IN);
    await drainMicrotasks();
    assert.equal(attempts.length, 2, "a settled identity is not re-claimed");
  });

  test("a settled-but-skipped claim is not retried, and a different user is", async () => {
    const attempts: DbHostUserIdentity[] = [];
    const tracker = createSessionOwnerClaimTracker({
      claim: (identity) => {
        attempts.push(identity);
        // Foreign owner present / nothing to claim: a settled answer that cannot
        // change without a different identity arriving.
        return Promise.resolve({ claimed: 0 });
      },
      log: () => {
        // no assertion on logs here
      },
    });

    tracker.onIdentity(SIGNED_IN);
    await drainMicrotasks();
    tracker.onIdentity(SIGNED_IN);
    await drainMicrotasks();
    assert.equal(attempts.length, 1, "a skipped claim is still settled");

    tracker.onIdentity({ userId: "u-other", organizationId: "org-other" });
    await drainMicrotasks();
    assert.equal(attempts.length, 2, "a different account is a cache miss");
  });

  test("a signed-out push and a store that is not open yet both stay retry-eligible", async () => {
    const attempts: DbHostUserIdentity[] = [];
    let storeOpen = false;
    const tracker = createSessionOwnerClaimTracker({
      claim: (identity) => {
        attempts.push(identity);
        return storeOpen ? Promise.resolve({ claimed: 1 }) : undefined;
      },
      log: () => {
        // no assertion on logs here
      },
    });

    tracker.onIdentity(null);
    tracker.onIdentity({ userId: null, organizationId: "org-closedloop" });
    await drainMicrotasks();
    assert.equal(attempts.length, 0, "there is nothing to stamp yet");

    tracker.onIdentity(SIGNED_IN);
    await drainMicrotasks();
    assert.equal(attempts.length, 1, "attempted, but the store was not open");

    storeOpen = true;
    tracker.onIdentity(SIGNED_IN);
    await drainMicrotasks();
    assert.equal(
      attempts.length,
      2,
      "a claim the closed store could not run must not settle the identity"
    );
  });
});

/**
 * A fake forked db-host child that captures the client's listeners so a test can
 * complete the Init handshake and then read what main posted afterwards.
 */
function makeFakeChild() {
  const posted: { kind: string; id?: number; identity?: DbHostUserIdentity }[] =
    [];
  let exitListener: DbHostChildExitListener | undefined;
  let messageListener: DbHostChildMessageListener | undefined;
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
    postMessage(message: {
      kind: string;
      id?: number;
      identity?: DbHostUserIdentity;
    }) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    posted,
    exit(code: number | null) {
      exitListener?.(code);
    },
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
  };
}

function runtimeOptions(
  userDataPath: string,
  getUserIdentity: () => DbHostUserIdentity,
  identityListeners: Set<() => void>
): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender: () => false,
    userDataPath,
    getUserIdentity,
    // ISS-6243 replaced this ticket's 5s poll with the production identity-change
    // signal (the credential store + the `/me` resolver, fanned out by
    // `createUserIdentityChangeSubscription`). The CONTRACT these legs assert is
    // unchanged — a late-resolving identity must reach the child, a signed-out
    // install must never be told it has an owner — only the trigger moved from a
    // timer to the event the resolver now emits.
    subscribeUserIdentityChanged: (listener: () => void) => {
      identityListeners.add(listener);
      return () => {
        identityListeners.delete(listener);
      };
    },
  } as unknown as AgentDashboardDesignSystemRuntimeOptions;
}

describe("ISS-6168 db-host lifecycle identity push (behavioral)", () => {
  let electronMock: ElectronModuleMock;
  let createLifecycle: typeof CreateLifecycle;

  before(async () => {
    // `agent-dashboard-runtime-paths.ts` imports `electron` at module scope,
    // which throws under `tsx --test` — the ISS-4845 redirect mechanism.
    electronMock = registerElectronModuleMock();
    ({ createAgentDashboardDbHostLifecycle: createLifecycle } = await import(
      "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js"
    ));
  });

  after(() => {
    electronMock.deregister();
  });

  test("an identity that resolves after the store opened is pushed to the db host", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    // The production shape: main's resolver answers null on its first call
    // (it only warms `/me` in the background) and non-null once warmed.
    let resolved: DbHostUserIdentity = null;
    const identityListeners = new Set<() => void>();
    const fake = makeFakeChild();
    const lifecycle = createLifecycle({
      options: runtimeOptions(
        "/tmp/iss-6168-identity-push",
        () => resolved,
        identityListeners
      ),
      log: () => {
        // no assertion on logs here
      },
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      fork: () => fake.child,
    });
    try {
      while (fake.posted.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const init = fake.posted.find((m) => m.kind === DbHostRequestKind.Init) as
        | { identity?: DbHostUserIdentity }
        | undefined;
      assert.equal(
        init?.identity ?? null,
        null,
        "the cold-start snapshot is null — the whole reason the push exists"
      );
      fake.ready();
      await lifecycle.ready;

      // The background `/me` lands: the resolver now answers, and announces it.
      resolved = SIGNED_IN;
      for (const listener of identityListeners) {
        listener();
      }
      const pushed = await waitFor(() =>
        fake.posted.find((m) => m.kind === DbHostRequestKind.SetUserIdentity)
      );
      assert.deepEqual(pushed?.identity, SIGNED_IN);
    } finally {
      lifecycle.beginClosing();
      await lifecycle.close().catch(() => undefined);
    }
  });

  test("no identity is pushed while the provider keeps answering null", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const identityListeners = new Set<() => void>();
    const fake = makeFakeChild();
    const lifecycle = createLifecycle({
      options: runtimeOptions(
        "/tmp/iss-6168-identity-null",
        () => null,
        identityListeners
      ),
      log: () => {
        // no assertion on logs here
      },
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      fork: () => fake.child,
    });
    try {
      while (fake.posted.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      fake.ready();
      await lifecycle.ready;
      // Announce repeatedly. Each notification re-reads the provider, which keeps
      // answering null — the same null the child opened with, so there is nothing
      // to tell it. This is a stronger probe than waiting out a timer: it drives
      // the publisher's decision path directly.
      for (let announcement = 0; announcement < 10; announcement++) {
        for (const listener of identityListeners) {
          listener();
        }
      }
      await drainMicrotasks();
      assert.equal(
        fake.posted.filter((m) => m.kind === DbHostRequestKind.SetUserIdentity)
          .length,
        0,
        "a signed-out install must never be told it has an owner"
      );
    } finally {
      lifecycle.beginClosing();
      await lifecycle.close().catch(() => undefined);
    }
  });
});

/** Poll until `read` returns a value, or fail loudly at the test's own bound. */
async function waitFor<T>(
  read: () => T | undefined,
  budgetMs = 5000
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
  }
  return undefined;
}
