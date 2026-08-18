/**
 * @file org-directory-persistence-store.test.ts
 * @description Unit tests for the electron-store-backed durable org-directory
 * snapshot store (FEA-3457), src/main/session/org-directory-persistence-store.ts.
 *
 * Reviewed invariants: (1) a saved `(identityKey, users)` snapshot round-trips
 * through load(); (2) FEA-3517 — a corrupt on-disk `users` array degrades to
 * "no persisted snapshot" instead of crashing the read path: load() drops any
 * element that is not a well-formed BasicUser (null / non-object / missing id)
 * and returns null when none survive, so the cache's rehydrate `new Map(
 * users.map((u) => [u.id, u]))` never sees a malformed element; (3) a
 * shallowly-invalid record (missing identityKey, non-array users) still yields
 * null. Each test isolates an electron-store in a temp dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { BasicUser } from "@repo/api/src/types/user";
import Store from "electron-store";
import { createOrgDirectoryPersistenceStore } from "../src/main/session/org-directory-persistence-store.js";

const STORE_NAME = "org-directory-cache";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "org-directory-persistence-store-test-")
  );
  tempDirs.push(dir);
  return dir;
}

function makeUser(id: string): BasicUser {
  return {
    id,
    email: `${id}@example.com`,
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
  };
}

/** Write a raw `snapshot` record straight to the on-disk store (simulating a
 * hand-edited / partially-written / corrupted file the store must tolerate). */
function seedRawSnapshot(dir: string, snapshot: unknown): void {
  const raw = new Store({ name: STORE_NAME, cwd: dir });
  raw.set("snapshot", snapshot);
}

test("save/load round-trips a well-formed snapshot", () => {
  const dir = makeTempDir();
  const store = createOrgDirectoryPersistenceStore({ cwd: dir });
  const record = { identityKey: "fingerprint", users: [makeUser("u1")] };

  store.save(record);
  assert.deepEqual(store.load(), record);
});

test("load returns null when there is no persisted snapshot", () => {
  const store = createOrgDirectoryPersistenceStore({ cwd: makeTempDir() });
  assert.equal(store.load(), null);
});

test("clear() drops the persisted snapshot", () => {
  const store = createOrgDirectoryPersistenceStore({ cwd: makeTempDir() });
  store.save({ identityKey: "fingerprint", users: [makeUser("u1")] });
  store.clear();
  assert.equal(store.load(), null);
});

test("FEA-3517: load() drops malformed elements and keeps well-formed users", () => {
  const dir = makeTempDir();
  seedRawSnapshot(dir, {
    identityKey: "fingerprint",
    // A null and a non-object element (dereferencing `.id` on either crashes
    // the cache's rehydrate `new Map(users.map((u) => [u.id, u]))`) alongside
    // two valid BasicUser rows.
    users: [makeUser("u1"), null, "not-an-object", makeUser("u2")],
  });

  const store = createOrgDirectoryPersistenceStore({ cwd: dir });
  const loaded = store.load();

  assert.deepEqual(loaded, {
    identityKey: "fingerprint",
    users: [makeUser("u1"), makeUser("u2")],
  });
});

test("FEA-3517: load() drops elements missing a string id", () => {
  const dir = makeTempDir();
  // These object elements would not crash the rehydrate map (they have an `id`
  // property), but a numeric/absent id would silently mis-key the owner Map, so
  // shape-hardening drops them too.
  seedRawSnapshot(dir, {
    identityKey: "fingerprint",
    users: [
      {
        email: "no-id@example.com",
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
      { ...makeUser("u1"), id: 42 },
      makeUser("u2"),
    ],
  });

  const store = createOrgDirectoryPersistenceStore({ cwd: dir });
  assert.deepEqual(store.load(), {
    identityKey: "fingerprint",
    users: [makeUser("u2")],
  });
});

test("FEA-3517: load() returns null when no element survives filtering", () => {
  const dir = makeTempDir();
  seedRawSnapshot(dir, {
    identityKey: "fingerprint",
    users: [null, "bad", { id: 1 }],
  });

  const store = createOrgDirectoryPersistenceStore({ cwd: dir });
  assert.equal(store.load(), null);
});

test("FEA-3517: load() reports dropped/kept counts via onCorruptEntriesDropped", () => {
  const dir = makeTempDir();
  seedRawSnapshot(dir, {
    identityKey: "fingerprint",
    users: [makeUser("u1"), null, "not-an-object", makeUser("u2")],
  });

  const calls: { kept: number; dropped: number }[] = [];
  const store = createOrgDirectoryPersistenceStore({
    cwd: dir,
    onCorruptEntriesDropped: (info) => calls.push(info),
  });
  const loaded = store.load();

  // Valid siblings survive; only the 2 malformed entries are dropped, and the
  // skip is observable (not a silent swallow).
  assert.deepEqual(loaded, {
    identityKey: "fingerprint",
    users: [makeUser("u1"), makeUser("u2")],
  });
  assert.deepEqual(calls, [{ kept: 2, dropped: 2 }]);
});

test("load() does not invoke onCorruptEntriesDropped for a clean snapshot", () => {
  const dir = makeTempDir();
  const store = createOrgDirectoryPersistenceStore({
    cwd: dir,
    onCorruptEntriesDropped: () => {
      throw new Error("must not be called for a well-formed snapshot");
    },
  });
  store.save({ identityKey: "fingerprint", users: [makeUser("u1")] });
  assert.deepEqual(store.load(), {
    identityKey: "fingerprint",
    users: [makeUser("u1")],
  });
});

test("FEA-3517: a throwing observer cannot crash load()", () => {
  const dir = makeTempDir();
  seedRawSnapshot(dir, {
    identityKey: "fingerprint",
    users: [makeUser("u1"), null],
  });
  const store = createOrgDirectoryPersistenceStore({
    cwd: dir,
    onCorruptEntriesDropped: () => {
      throw new Error("boom");
    },
  });
  // The observer throws, but load() still returns the surviving user rather than
  // letting observability break the best-effort read path.
  assert.deepEqual(store.load(), {
    identityKey: "fingerprint",
    users: [makeUser("u1")],
  });
});

test("load() returns null for a shallowly-invalid record", () => {
  const dir = makeTempDir();
  seedRawSnapshot(dir, { identityKey: 123, users: "not-an-array" });

  const store = createOrgDirectoryPersistenceStore({ cwd: dir });
  assert.equal(store.load(), null);
});
