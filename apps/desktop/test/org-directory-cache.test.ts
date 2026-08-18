/**
 * @file org-directory-cache.test.ts
 * Unit tests for the desktop owner-identity resolution cache
 * (src/main/session/org-directory-cache.ts).
 *
 * Covers:
 *   - resolveOwner: null on missing id / miss; hit returns the BasicUser.
 *   - ownerDisplayName: full name → name part → email fallback.
 *   - buildByUserRollup: groups by userId, sums tokens, drops unresolved/null,
 *     orders by session count desc.
 *   - ensureOrgDirectory: fetches + populates snapshot from GET /users, awaits on
 *     empty cache, serves cached within TTL, refreshes past TTL, tolerates a
 *     failed fetch (keeps the last snapshot / stays empty), and applies a failure
 *     backoff so a failed/empty fetch does not re-await on the next list call.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  buildByUserRollup,
  configureOrgDirectoryPersistence,
  ensureOrgDirectory,
  getOrgDirectorySnapshot,
  type OrgDirectoryPersistence,
  ownerDisplayName,
  resetOrgDirectoryCacheForTest,
  resolveOwner,
} from "../src/main/session/org-directory-cache.js";
import { displayUserName } from "../src/main/session/user-display-name.js";

function user(overrides: Partial<BasicUser> & { id: string }): BasicUser {
  return {
    email: `${overrides.id}@example.com`,
    firstName: null,
    lastName: null,
    avatarUrl: null,
    ...overrides,
  };
}

const ADA = user({ id: "u1", firstName: "Ada", lastName: "Lovelace" });
const SNAPSHOT = new Map<string, BasicUser>([[ADA.id, ADA]]);

/** A SHA-256 hex digest: 64 lowercase hex chars — the persisted identity key. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
};

function okUsersResponse(users: BasicUser[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ success: true, data: users }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const FETCH_OPTS = {
  getApiOrigin: () => "https://api.test",
  getApiKey: () => "sk_live_test",
};

// Epoch-scale clock. Production `nowMs` is real wall-clock (~1.78e12), where a
// failed/empty fetch (which leaves `lastFetchedAtMs` at 0) makes `isStale`
// unconditionally true. Toy clocks below the 300_000ms TTL kept `isStale` false
// in-test and masked the failure-backoff regression — drive `nowMs` from a real
// epoch so these tests exercise the same arithmetic prod does.
const NOW = 1_780_000_000_000;

afterEach(() => {
  resetOrgDirectoryCacheForTest();
});

describe("resolveOwner", () => {
  test("returns null for a null/absent id", () => {
    assert.equal(resolveOwner(null, SNAPSHOT), null);
    assert.equal(resolveOwner(undefined, SNAPSHOT), null);
  });

  test("returns null when the id is not in the directory", () => {
    assert.equal(resolveOwner("nope", SNAPSHOT), null);
  });

  test("returns the resolved user on a hit", () => {
    assert.deepEqual(resolveOwner("u1", SNAPSHOT), ADA);
  });
});

describe("ownerDisplayName", () => {
  test("prefers the full name", () => {
    assert.equal(ownerDisplayName(ADA), "Ada Lovelace");
  });

  test("falls back to a single name part", () => {
    assert.equal(
      ownerDisplayName(user({ id: "u2", firstName: "Grace" })),
      "Grace"
    );
  });

  test("falls back to email when no name is present", () => {
    assert.equal(
      ownerDisplayName(user({ id: "u3", email: "hopper@example.com" })),
      "hopper@example.com"
    );
  });

  // FEA-3606 byte-for-byte parity guards: `ownerDisplayName` is now a thin
  // wrapper over the desktop-main SSOT `displayUserName`, whose name-part
  // collapse trims. These pin the exact pre-consolidation outputs so the
  // extraction stays behavior-preserving.
  test("falls back to a single last-name part", () => {
    assert.equal(
      ownerDisplayName(user({ id: "u4", lastName: "Hopper" })),
      "Hopper"
    );
  });

  test("trims a whitespace-only name to fall back to email", () => {
    assert.equal(
      ownerDisplayName(
        user({
          id: "u5",
          firstName: "   ",
          lastName: null,
          email: "ws@example.com",
        })
      ),
      "ws@example.com"
    );
  });

  test("matches the shared displayUserName SSOT for every case", () => {
    const cases: BasicUser[] = [
      ADA,
      user({ id: "c1", firstName: "Grace" }),
      user({ id: "c2", lastName: "Hopper" }),
      user({ id: "c3", email: "only@example.com" }),
      user({ id: "c4", firstName: "  ", email: "ws@example.com" }),
    ];
    for (const u of cases) {
      assert.equal(ownerDisplayName(u), displayUserName(u));
    }
  });
});

describe("buildByUserRollup", () => {
  test("groups sessions by user, sums tokens, and joins identity", () => {
    const rollup = buildByUserRollup(
      [
        {
          userId: "u1",
          totals: { ...ZERO, inputTokens: 10, estimatedCost: 1 },
        },
        { userId: "u1", totals: { ...ZERO, inputTokens: 5, estimatedCost: 2 } },
      ],
      SNAPSHOT
    );
    assert.equal(rollup.length, 1);
    assert.deepEqual(
      {
        userId: rollup[0].userId,
        userName: rollup[0].userName,
        userEmail: rollup[0].userEmail,
        sessionCount: rollup[0].sessionCount,
        inputTokens: rollup[0].inputTokens,
        estimatedCost: rollup[0].estimatedCost,
      },
      {
        userId: "u1",
        userName: "Ada Lovelace",
        userEmail: "u1@example.com",
        sessionCount: 2,
        inputTokens: 15,
        estimatedCost: 3,
      }
    );
  });

  test("drops sessions with a null or unresolved owner", () => {
    const rollup = buildByUserRollup(
      [
        { userId: null, totals: ZERO },
        { userId: "ghost", totals: ZERO },
        { userId: "u1", totals: ZERO },
      ],
      SNAPSHOT
    );
    assert.deepEqual(
      rollup.map((r) => r.userId),
      ["u1"]
    );
  });

  test("orders by session count descending", () => {
    const bob = user({ id: "u2", firstName: "Bob" });
    const snapshot = new Map([...SNAPSHOT, [bob.id, bob]]);
    const rollup = buildByUserRollup(
      [
        { userId: "u1", totals: ZERO },
        { userId: "u2", totals: ZERO },
        { userId: "u2", totals: ZERO },
      ],
      snapshot
    );
    assert.deepEqual(
      rollup.map((r) => r.userId),
      ["u2", "u1"]
    );
  });
});

describe("ensureOrgDirectory", () => {
  test("awaits and populates the snapshot on an empty cache", async () => {
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
  });

  test("serves the cached snapshot within the TTL (no refetch)", async () => {
    let calls = 0;
    const counting = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [ADA] }), {
          status: 200,
        })
      );
    }) as unknown as typeof fetch;
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: counting }, NOW);
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: counting },
      NOW + 1000
    );
    assert.equal(calls, 1);
  });

  test("keeps serving null owners when the fetch fails", async () => {
    const failing = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: failing }, NOW);
    assert.equal(getOrgDirectorySnapshot().size, 0);
    assert.equal(resolveOwner("u1", getOrgDirectorySnapshot()), null);
  });

  test("a failed fetch does not re-await/re-fetch on the next list call within the backoff", async () => {
    let calls = 0;
    const failing = (() => {
      calls += 1;
      return Promise.reject(new Error("offline"));
    }) as unknown as typeof fetch;
    // First cold read attempts the fetch (and fails → empty snapshot).
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: failing }, NOW);
    assert.equal(calls, 1);
    assert.equal(getOrgDirectorySnapshot().size, 0);
    // The immediately-following list call, still inside the failure backoff,
    // must NOT re-await a fresh (up-to-10s) fetch — no second attempt is issued.
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: failing }, NOW + 500);
    assert.equal(calls, 1);
    assert.equal(getOrgDirectorySnapshot().size, 0);
  });

  test("retries the failed fetch once the failure backoff elapses", async () => {
    let calls = 0;
    // Fail the first attempt, then succeed on the retry after the backoff.
    const flaky = (() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("offline"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [ADA] }), {
          status: 200,
        })
      );
    }) as unknown as typeof fetch;
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: flaky }, NOW);
    assert.equal(calls, 1);
    // Well past the 30s failure backoff: the cold cache re-attempts and, on this
    // successful retry, populates the snapshot.
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: flaky }, NOW + 60_000);
    assert.equal(calls, 2);
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
  });

  test("an empty (zero-user) fetch is also gated by the failure backoff", async () => {
    let calls = 0;
    const emptyOk = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
        })
      );
    }) as unknown as typeof fetch;
    // A successful-but-empty directory leaves the snapshot empty; the next list
    // call within the backoff must not re-await another fetch.
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: emptyOk }, NOW);
    assert.equal(calls, 1);
    assert.equal(getOrgDirectorySnapshot().size, 0);
    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: emptyOk }, NOW + 500);
    assert.equal(calls, 1);
  });

  test("is a no-op when origin or key is missing", async () => {
    await ensureOrgDirectory(
      {
        getApiOrigin: () => undefined,
        getApiKey: () => "sk_live_test",
        fetchImpl: okUsersResponse([ADA]),
      },
      NOW
    );
    assert.equal(getOrgDirectorySnapshot().size, 0);
  });

  test("clears the prior account's snapshot when the identity changes", async () => {
    const bob = user({ id: "u2", firstName: "Bob" });
    // Warm the cache for org A within its TTL.
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
    // Switch orgs (new origin) — still inside org A's TTL, but the stale
    // snapshot must not leak, so org B is refetched immediately.
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api-b.test",
        getApiKey: () => "sk_live_test",
        fetchImpl: okUsersResponse([bob]),
      },
      NOW + 1000
    );
    assert.equal(resolveOwner("u1", getOrgDirectorySnapshot()), null);
    assert.deepEqual(resolveOwner("u2", getOrgDirectorySnapshot()), bob);
  });

  test("clears the snapshot on sign-out (missing credentials)", async () => {
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    assert.equal(getOrgDirectorySnapshot().size, 1);
    // Sign out — no key. The previous account's directory must be forgotten
    // even though it is still within the TTL.
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api.test",
        getApiKey: () => null,
        fetchImpl: okUsersResponse([ADA]),
      },
      NOW + 1000
    );
    assert.equal(getOrgDirectorySnapshot().size, 0);
  });

  test("does not commit an in-flight fetch for a since-switched identity", async () => {
    // A single shared options object with live getters, mirroring the real
    // caller (getApiOrigin/getApiKey read current app state).
    let origin = "https://api.test";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = {
      getApiOrigin: () => origin,
      getApiKey: () => "sk_live_test",
      fetchImpl: (async () => {
        // Owner=Ada, but block until the identity has switched away.
        await gate;
        return new Response(JSON.stringify({ success: true, data: [ADA] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    };
    // Start the (empty-cache) fetch under org A; do not await yet.
    const pending = ensureOrgDirectory(options, NOW);
    // Switch to org B before A's fetch resolves, then let A resolve.
    origin = "https://api-b.test";
    release?.();
    await pending;
    // A's response must NOT populate the snapshot under identity B.
    assert.equal(getOrgDirectorySnapshot().size, 0);
    assert.equal(resolveOwner("u1", getOrgDirectorySnapshot()), null);
  });
});

// FEA-3457 — durable owner attribution: the snapshot is persisted on a
// successful fetch and rehydrated on cold start (identity-scoped), so the
// Branches/Sessions "Owner" column resolves immediately at boot / offline
// instead of reading blank until a live fetch lands.
describe("org-directory persistence (FEA-3457)", () => {
  /** In-memory OrgDirectoryPersistence with call spies. */
  function makePersistence(seed?: {
    identityKey: string;
    users: BasicUser[];
  }): OrgDirectoryPersistence & {
    saves: { identityKey: string; users: BasicUser[] }[];
    clears: number;
    record: { identityKey: string; users: BasicUser[] } | null;
  } {
    const state = {
      record: seed ?? null,
      saves: [] as { identityKey: string; users: BasicUser[] }[],
      clears: 0,
      load() {
        return state.record;
      },
      save(record: { identityKey: string; users: BasicUser[] }) {
        state.record = record;
        state.saves.push(record);
      },
      clear() {
        state.record = null;
        state.clears += 1;
      },
    };
    return state;
  }

  // The cache derives its persisted identity key internally (a one-way SHA-256
  // fingerprint of origin + key), so rather than recompute that digest here,
  // capture the real persisted record from a live fetch's save. Warms under
  // FETCH_OPTS, then resets, returning the record.
  async function captureFetchedRecord(): Promise<{
    identityKey: string;
    users: BasicUser[];
  } | null> {
    const store = makePersistence();
    configureOrgDirectoryPersistence(store);
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    const record = store.record;
    resetOrgDirectoryCacheForTest();
    return record;
  }

  test("persists the directory on a successful fetch", async () => {
    const store = makePersistence();
    configureOrgDirectoryPersistence(store);
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    assert.equal(store.saves.length, 1);
    // SECURITY (FEA-3457): the persisted identity key is a one-way SHA-256
    // fingerprint, NOT the raw credential — the on-disk store is unencrypted, so
    // the live `sk_live` key (and the origin) must never appear in it. It still
    // scope-checks identity by equality, and the users round-trip intact.
    const persistedKey = store.saves[0].identityKey;
    assert.ok(!persistedKey.includes("sk_live_test"));
    assert.ok(!persistedKey.includes("https://api.test"));
    assert.match(persistedKey, SHA256_HEX);
    assert.deepEqual(store.saves[0].users, [ADA]);
  });

  test("rehydrates a persisted snapshot on a cold start WITHOUT a live fetch", async () => {
    // A prior process's persisted record (real identity key), then a cold start:
    // no in-memory snapshot, offline fetch — owners must resolve from disk alone.
    const record = await captureFetchedRecord();
    assert.ok(record);
    const store = makePersistence(record);
    configureOrgDirectoryPersistence(store);
    let fetchCalls = 0;
    const throwingFetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error("offline"));
    }) as unknown as typeof fetch;

    await ensureOrgDirectory({ ...FETCH_OPTS, fetchImpl: throwingFetch }, NOW);

    // Owner resolves immediately from the rehydrated snapshot, even offline.
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
    // A failed background refresh does not wipe the rehydrated snapshot.
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
    assert.ok(fetchCalls <= 1);
  });

  test("does NOT rehydrate a persisted snapshot from a different identity", async () => {
    // Persisted under org A, but we sign in as org B — the stale directory must
    // never resolve owners for the wrong account.
    const record = await captureFetchedRecord();
    assert.ok(record);
    const store = makePersistence(record);
    configureOrgDirectoryPersistence(store);
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api-B.test",
        getApiKey: () => "sk_live_B",
        fetchImpl: (() =>
          Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      },
      NOW
    );
    assert.equal(getOrgDirectorySnapshot().size, 0);
    assert.equal(resolveOwner("u1", getOrgDirectorySnapshot()), null);
  });

  test("clears the persisted snapshot on sign-out", async () => {
    const record = await captureFetchedRecord();
    assert.ok(record);
    const store = makePersistence(record);
    configureOrgDirectoryPersistence(store);
    // Warm from disk first.
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    assert.equal(getOrgDirectorySnapshot().size, 1);
    // Sign out (no key): the durable store must be wiped so a later account on
    // this machine cannot rehydrate this account's directory.
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api.test",
        getApiKey: () => null,
        fetchImpl: okUsersResponse([ADA]),
      },
      NOW + 1000
    );
    assert.equal(getOrgDirectorySnapshot().size, 0);
    assert.ok(store.clears >= 1);
    assert.equal(store.record, null);
  });

  test("survives a full cold-start cycle: fetch -> persist -> reset -> rehydrate", async () => {
    const store = makePersistence();
    configureOrgDirectoryPersistence(store);
    // Process 1: live fetch populates and persists.
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
    const persisted = store.record;
    assert.ok(persisted);

    // Simulate a process restart: in-memory state is wiped, but the persisted
    // record survives on disk. Re-wire a fresh store seeded with it (as the app
    // does at boot against the same on-disk file).
    resetOrgDirectoryCacheForTest();
    assert.equal(getOrgDirectorySnapshot().size, 0);
    configureOrgDirectoryPersistence(makePersistence(persisted ?? undefined));

    // Process 2 cold start, offline: owner still resolves from the rehydrated
    // snapshot with no successful network call.
    await ensureOrgDirectory(
      {
        ...FETCH_OPTS,
        fetchImpl: (() =>
          Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      },
      NOW + 10 * 60 * 1000
    );
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
  });

  test("tolerates a throwing persistence store (degrades to in-memory)", async () => {
    const brokenStore: OrgDirectoryPersistence = {
      load() {
        throw new Error("corrupt store");
      },
      save() {
        throw new Error("read-only disk");
      },
      clear() {
        throw new Error("locked");
      },
    };
    configureOrgDirectoryPersistence(brokenStore);
    // A load/save throw must not break the fetch path — owners still resolve
    // from the freshly-fetched in-memory snapshot.
    await ensureOrgDirectory(
      { ...FETCH_OPTS, fetchImpl: okUsersResponse([ADA]) },
      NOW
    );
    assert.deepEqual(resolveOwner("u1", getOrgDirectorySnapshot()), ADA);
  });
});
