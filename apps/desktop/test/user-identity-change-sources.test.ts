/**
 * @file user-identity-change-sources.test.ts
 * @description ISS-6243 — the two places main can observe the signed-in
 * identity changing, plus the publisher that turns those observations into
 * db-host pushes.
 *
 * `db-host-identity-propagation.test.ts` proves the lifecycle is wired to a
 * subscription. These legs prove the subscriptions production hands it actually
 * fire on the transitions that matter — a background `/me` landing after a cold
 * start, a key rotation on an org switch, a key removal on sign-out — and that
 * the publisher deduplicates on the PAIR rather than on the user id.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import type { DbHostIdentityPublisher } from "../src/main/database/db-host/db-host-identity-publisher.js";
import { createDbHostIdentityPublisher } from "../src/main/database/db-host/db-host-identity-publisher.js";
import type { DbHostUserIdentity } from "../src/main/database/db-host/db-host-protocol.js";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/settings/api-key-store.js";
import type { TraceCommentUserIdentity } from "../src/main/trace-comments/trace-comment-identity-resolver.js";
import { TraceCommentIdentityResolver } from "../src/main/trace-comments/trace-comment-identity-resolver.js";
import {
  createUserIdentityChangeSubscription,
  sameUserIdentity,
} from "../src/main/util/user-identity.js";

const ALICE: DbHostUserIdentity = {
  userId: "user_alice",
  organizationId: "org_one",
};
const ALICE_IN_OTHER_ORG = {
  userId: "user_alice",
  organizationId: "org_two",
};
/** The env fallbacks `ApiKeyStore.getApiKey()` reads when no key is stored. */
const ENVIRONMENT_KEY_VARIABLES = [
  "CLOSEDLOOP_API_KEY",
  "SYMPHONY_API_KEY",
] as const;

const tempDirs: string[] = [];
const savedEnvironmentKeys = new Map<string, string | undefined>();

beforeEach(() => {
  // A key in the ambient environment makes `getApiKey()` answer even after
  // `clearApiKey()`, which would quietly invert the sign-out legs below.
  for (const name of ENVIRONMENT_KEY_VARIABLES) {
    savedEnvironmentKeys.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
});

afterEach(() => {
  for (const [name, value] of savedEnvironmentKeys) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
  savedEnvironmentKeys.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) =>
      Buffer.from(`stub:${plainText}`, "utf-8"),
    decryptString: (encrypted: Buffer) => {
      const value = encrypted.toString("utf-8");
      return value.startsWith("stub:") ? value.slice(5) : value;
    },
  };
}

function makeApiKeyStore(): ApiKeyStore {
  return new ApiKeyStore({
    cwd: makeTempDir("iss-6243-secrets-"),
    name: "secrets",
    safeStorage: makeSafeStorage(),
  });
}

/** A `/me` responder that answers with `identity` for any key. */
function meResponder(identity: { id: string; organizationId: string }) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true, data: identity }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
}

describe("ApiKeyStore identity change notifications (ISS-6243)", () => {
  test("announces a key being set, rotated, and cleared", () => {
    const store = makeApiKeyStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });

    store.setApiKey("sk_live_first");
    assert.equal(notifications, 1, "a sign-in must be announced");

    store.setApiKey("sk_live_second");
    assert.equal(notifications, 2, "an org switch rotates the key");

    store.clearApiKey();
    assert.equal(notifications, 3, "a sign-out must be announced");
  });

  test("a listener sees the new credential, not the old one", () => {
    const store = makeApiKeyStore();
    store.setApiKey("sk_live_first");
    const observed: (string | null)[] = [];
    store.subscribe(() => {
      observed.push(store.getApiKey());
    });

    store.setApiKey("sk_live_second");
    store.clearApiKey();

    assert.deepEqual(
      observed,
      ["sk_live_second", null],
      "listeners run after the write, so a sign-out reads as signed out"
    );
  });

  test("unsubscribing stops the notifications", () => {
    const store = makeApiKeyStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications++;
    });

    unsubscribe();
    store.setApiKey("sk_live_first");

    assert.equal(notifications, 0);
  });

  test("a throwing listener cannot fail the credential write", () => {
    const store = makeApiKeyStore();
    let reached = 0;
    store.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    store.subscribe(() => {
      reached++;
    });

    // Sign-out has ALREADY mutated the store by the time listeners run, so a
    // throw here would report a failure for work that did happen.
    store.setApiKey("sk_live_first");
    store.clearApiKey();

    assert.equal(store.getApiKey(), null);
    assert.equal(reached, 2, "one bad subscriber must not strand the others");
  });
});

describe("TraceCommentIdentityResolver identity transitions (ISS-6243)", () => {
  test("announces the identity the background /me resolves", async () => {
    let apiKey: string | null = "sk_live_first";
    const resolver = new TraceCommentIdentityResolver({
      getApiKey: () => apiKey,
      getApiOrigin: () => "https://api.example.test",
      fetchImpl: meResponder({ id: "user_alice", organizationId: "org_one" }),
    });
    const observed: (TraceCommentUserIdentity | null)[] = [];
    resolver.subscribe(() => {
      observed.push(resolver.resolve());
    });

    // The cold-start read: null now, `/me` warming in the background. THIS is
    // the value the db-host Init snapshot is taken from.
    assert.equal(resolver.resolve(), null);
    await settleWarm();

    assert.deepEqual(
      observed,
      [ALICE],
      "the resolved identity must be announced, or nothing ever learns it"
    );
    assert.deepEqual(resolver.resolve(), ALICE);
    assert.equal(
      observed.length,
      1,
      "a repeat read of an unchanged identity announces nothing"
    );

    apiKey = null;
    assert.equal(resolver.resolve(), null);
    assert.deepEqual(
      observed,
      [ALICE, null],
      "losing the credential must be announced as a transition to null"
    );
  });

  test("a key rotation announces null before the new identity resolves", async () => {
    let apiKey = "sk_live_first";
    let me = { id: "user_alice", organizationId: "org_one" };
    const resolver = new TraceCommentIdentityResolver({
      getApiKey: () => apiKey,
      getApiOrigin: () => "https://api.example.test",
      fetchImpl: () => meResponder(me)(),
    });
    const observed: (TraceCommentUserIdentity | null)[] = [];
    resolver.subscribe(() => {
      observed.push(resolver.resolve());
    });

    resolver.resolve();
    await settleWarm();
    assert.deepEqual(observed, [ALICE]);

    // Org switch: a new key for the same human in a different org.
    apiKey = "sk_live_second";
    me = { id: "user_alice", organizationId: "org_two" };
    resolver.resolve();
    await settleWarm();

    assert.deepEqual(
      observed,
      [ALICE, null, ALICE_IN_OTHER_ORG],
      "the old org's identity is retracted first — a stale pair attributes sessions to the wrong org"
    );
  });

  test("a throwing listener cannot break resolve() for other callers", async () => {
    let apiKey: string | null = "sk_live_first";
    const resolver = new TraceCommentIdentityResolver({
      getApiKey: () => apiKey,
      getApiOrigin: () => "https://api.example.test",
      fetchImpl: meResponder({ id: "user_alice", organizationId: "org_one" }),
    });
    let reached = 0;
    resolver.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    resolver.subscribe(() => {
      reached++;
    });

    // Transition 1: the background `/me` lands.
    resolver.resolve();
    await settleWarm();
    assert.deepEqual(resolver.resolve(), ALICE);

    // Transition 2: the credential goes away. resolve() is the local-first read
    // several unrelated lanes call on their hot path, and it is documented never
    // to throw on cloud auth — a subscriber must not be able to change that.
    apiKey = null;
    assert.equal(resolver.resolve(), null);
    assert.equal(reached, 2, "one bad subscriber must not strand the others");
  });

  // Review thread (wongk, PR #4964): onboarding commits the key and the API
  // origin in two separate steps, so a lookup can legitimately be issued against
  // the previous cloud. A fingerprint-only cache key would then serve that
  // wrong-cloud answer for the new origin forever.
  test("an API origin change invalidates the cached identity", async () => {
    let apiOrigin = "https://old.example.test";
    const apiKey = "sk_live_same_key_both_clouds";
    const resolver = new TraceCommentIdentityResolver({
      getApiKey: () => apiKey,
      getApiOrigin: () => apiOrigin,
      fetchImpl: (input) =>
        meResponder(
          String(input).startsWith("https://old.")
            ? { id: "user_alice", organizationId: "org_one" }
            : { id: "user_alice", organizationId: "org_two" }
        )(),
    });

    resolver.resolve();
    await settleWarm();
    assert.deepEqual(resolver.resolve(), ALICE);

    apiOrigin = "https://new.example.test";

    assert.equal(
      resolver.resolve(),
      null,
      "the same key names a different account on a different cloud — the cache must miss"
    );
    await settleWarm();
    assert.deepEqual(
      resolver.resolve(),
      ALICE_IN_OTHER_ORG,
      "and re-resolve against the origin that is actually configured now"
    );
  });

  // Review thread (wongk, PR #4964): session ingestion reads the db host's
  // cached identity, never `resolve()`, so nothing re-kicks a failed cold-start
  // lookup. One transient failure used to leave every session of that process
  // unattributed.
  test("a transient /me failure is retried against the active credential", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let attempts = 0;
      const resolver = new TraceCommentIdentityResolver({
        getApiKey: () => "sk_live_first",
        getApiOrigin: () => "https://api.example.test",
        fetchImpl: () => {
          attempts++;
          return attempts === 1
            ? Promise.reject(new Error("network unreachable"))
            : meResponder({ id: "user_alice", organizationId: "org_one" })();
        },
      });
      const observed: (TraceCommentUserIdentity | null)[] = [];
      resolver.subscribe(() => {
        observed.push(resolver.resolve());
      });

      resolver.resolve();
      await settleWarm();
      assert.deepEqual(
        observed,
        [],
        "the first lookup failed — nothing resolved"
      );

      mock.timers.tick(60_000);
      await settleWarm();

      assert.equal(attempts, 2, "the ladder must issue a second lookup");
      assert.deepEqual(
        observed,
        [ALICE],
        "the retry must land the identity, or every session stays unattributed"
      );
    } finally {
      mock.timers.reset();
    }
  });

  test("a rejected credential is not retried", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let attempts = 0;
      const resolver = new TraceCommentIdentityResolver({
        getApiKey: () => "sk_live_revoked",
        getApiOrigin: () => "https://api.example.test",
        fetchImpl: () => {
          attempts++;
          return Promise.resolve(new Response("", { status: 401 }));
        },
      });

      resolver.resolve();
      await settleWarm();
      mock.timers.tick(600_000);
      await settleWarm();

      assert.equal(
        attempts,
        1,
        "the server answered — a revoked key will not become valid by asking again"
      );
    } finally {
      mock.timers.reset();
    }
  });

  test("unsubscribing stops the notifications", async () => {
    const resolver = new TraceCommentIdentityResolver({
      getApiKey: () => "sk_live_first",
      getApiOrigin: () => "https://api.example.test",
      fetchImpl: meResponder({ id: "user_alice", organizationId: "org_one" }),
    });
    let notifications = 0;
    const unsubscribe = resolver.subscribe(() => {
      notifications++;
    });

    unsubscribe();
    resolver.resolve();
    await settleWarm();

    assert.equal(notifications, 0);
  });
});

describe("createDbHostIdentityPublisher (ISS-6243)", () => {
  test("publishes only real changes", () => {
    let current: DbHostUserIdentity = null;
    const pushed: DbHostUserIdentity[] = [];
    const publisher = createDbHostIdentityPublisher({
      getIdentity: () => current,
      setIdentity: (identity) => pushed.push(identity),
    });

    publisher.sync();
    assert.deepEqual(
      pushed,
      [null],
      "the FIRST sync always publishes: what the child holds is unknown until then"
    );

    publisher.sync();
    assert.deepEqual(pushed, [null], "a repeat sync of it is not a change");

    current = ALICE;
    publisher.sync();
    publisher.sync();
    assert.deepEqual(
      pushed,
      [null, ALICE],
      "a repeat sync of it is not a change"
    );

    current = ALICE_IN_OTHER_ORG;
    publisher.sync();
    publisher.sync();
    assert.deepEqual(
      pushed,
      [null, ALICE, ALICE_IN_OTHER_ORG],
      "an org switch is a change; a repeat sync of it is not"
    );

    current = null;
    publisher.sync();
    assert.deepEqual(pushed.at(-1), null, "sign-out publishes null");
  });

  // Review thread (wongk, PR #4964): seeding `published` with `null` collapsed
  // "nothing published yet" into "published a signed-out machine". Init carried
  // ALICE, so the child opened as ALICE; she signs out before the host reports
  // Ready; the post-Ready reconcile then read null, deduped against the null
  // seed, and the child kept writing sessions as ALICE for its whole lifetime.
  test("a sign-out between Init and Ready still reaches the child", () => {
    let current: DbHostUserIdentity = ALICE;
    const pushed: DbHostUserIdentity[] = [];
    const publisher = createDbHostIdentityPublisher({
      getIdentity: () => current,
      setIdentity: (identity) => pushed.push(identity),
    });

    // The host is opened with ALICE in the Init snapshot — the publisher has
    // pushed nothing at this point. Then she signs out, before Ready.
    current = null;
    publisher.sync();

    assert.deepEqual(
      pushed,
      [null],
      "the retraction must be pushed, not deduped against an assumed null"
    );
  });

  test("stop() makes the publisher inert and drops its retained state", () => {
    let current: DbHostUserIdentity = null;
    const pushed: DbHostUserIdentity[] = [];
    const publisher = createDbHostIdentityPublisher({
      getIdentity: () => current,
      setIdentity: (identity) => pushed.push(identity),
    });

    publisher.stop();
    current = ALICE;
    publisher.sync();

    assert.deepEqual(
      pushed,
      [],
      "a notification racing teardown must not push into a closing client"
    );
  });

  test("a failed identity read leaves the last published value intact", () => {
    let failing = true;
    const pushed: DbHostUserIdentity[] = [];
    const publisher = createDbHostIdentityPublisher({
      getIdentity: () => {
        if (failing) {
          throw new Error("secrets store unreadable");
        }
        return ALICE;
      },
      setIdentity: (identity) => pushed.push(identity),
    });

    publisher.sync();
    assert.deepEqual(pushed, [], "nothing was learned, so nothing is claimed");

    // The next notification must still deliver — a transient read failure must
    // not record an identity the child was never told about.
    failing = false;
    publisher.sync();
    assert.deepEqual(pushed, [ALICE]);
  });

  test("re-entrant notification does not double-publish", () => {
    let current: DbHostUserIdentity = null;
    const pushed: DbHostUserIdentity[] = [];
    // Production shape: the identity sources notify from inside their own read
    // path, so `getIdentity()` can call back into `sync()`.
    const publisher: DbHostIdentityPublisher = createDbHostIdentityPublisher({
      getIdentity: () => {
        publisher.sync();
        return current;
      },
      setIdentity: (identity) => pushed.push(identity),
    });

    current = ALICE;
    publisher.sync();

    assert.deepEqual(pushed, [ALICE]);
  });
});

describe("sameUserIdentity (ISS-6243)", () => {
  test("compares the whole pair, in both directions", () => {
    assert.equal(sameUserIdentity(null, null), true);
    assert.equal(sameUserIdentity(null, ALICE), false);
    assert.equal(sameUserIdentity(ALICE, null), false);
    assert.equal(sameUserIdentity(ALICE, { ...ALICE }), true);
    assert.equal(
      sameUserIdentity(ALICE, ALICE_IN_OTHER_ORG),
      false,
      "same user, different org — an org switch"
    );
    assert.equal(
      sameUserIdentity(ALICE, {
        userId: "user_bob",
        organizationId: "org_one",
      }),
      false,
      "different user, same org — the arm an organizationId-only check would drop"
    );
    assert.equal(
      sameUserIdentity(ALICE, {
        userId: "user_bob",
        organizationId: "org_two",
      }),
      false
    );
  });
});

describe("createUserIdentityChangeSubscription (ISS-6243)", () => {
  test("fans out to the credential store AND the /me resolver", async () => {
    const store = makeApiKeyStore();
    const resolver = new TraceCommentIdentityResolver({
      getApiKey: () => store.getApiKey(),
      getApiOrigin: () => "https://api.example.test",
      fetchImpl: meResponder({ id: "user_alice", organizationId: "org_one" }),
    });
    // The production composition, over the REAL collaborators app.ts hands it.
    const subscribe = createUserIdentityChangeSubscription({
      apiKeyStore: store,
      identityResolver: resolver,
    });
    let notifications = 0;
    const unsubscribe = subscribe(() => {
      notifications++;
    });

    // Arm A — the credential store: sign-in, sign-out, and org switch.
    store.setApiKey("sk_live_first");
    assert.ok(notifications > 0, "a credential change must reach the listener");

    // Arm B — the resolver's background `/me`: the cold-start case that left
    // every session unattributed, and one arm A cannot observe.
    const afterCredential = notifications;
    resolver.resolve();
    await settleWarm();
    assert.ok(
      notifications > afterCredential,
      "a resolved identity must reach the listener too"
    );

    unsubscribe();
    const afterUnsubscribe = notifications;
    store.clearApiKey();
    resolver.resolve();
    await settleWarm();
    assert.equal(
      notifications,
      afterUnsubscribe,
      "unsubscribing must release BOTH arms, not just one"
    );
  });
});

/**
 * Let the resolver's background `/me` chain settle. Reading the response body is
 * a real async step, so this drains macrotask turns rather than microtasks.
 */
async function settleWarm(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
