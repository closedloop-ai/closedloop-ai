import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LocalSessionStore } from "../src/main/local-session-store.js";

// Each test creates its own store instance; no shared state to clean up.
afterEach(() => {
  // nothing to tear down
});

test("create() returns a session token and ISO expiration date", () => {
  const store = new LocalSessionStore();
  const before = Date.now();
  const { sessionToken, expiresAt } = store.create("http://localhost:3000");
  const after = Date.now();

  assert.ok(
    typeof sessionToken === "string",
    "sessionToken should be a string"
  );
  assert.ok(sessionToken.length > 0, "sessionToken should not be empty");

  const expiresAtMs = new Date(expiresAt).getTime();
  assert.ok(
    !Number.isNaN(expiresAtMs),
    "expiresAt should be a valid ISO date string"
  );
  assert.ok(
    expiresAtMs > before,
    "expiresAt should be in the future relative to before-create time"
  );
  assert.ok(
    expiresAtMs > after,
    "expiresAt should be in the future relative to after-create time"
  );
  // Default TTL is 600 seconds; verify the expiry is within a reasonable window
  assert.ok(
    expiresAtMs <= after + 601_000,
    "expiresAt should not exceed TTL + 1s buffer"
  );
});

test("validate() returns true for a valid token with the matching origin", () => {
  const store = new LocalSessionStore();
  const { sessionToken } = store.create("http://localhost:3000");

  assert.equal(store.validate(sessionToken, "http://localhost:3000"), true);
});

test("validate() returns false for a valid token with the wrong origin", () => {
  const store = new LocalSessionStore();
  const { sessionToken } = store.create("http://localhost:3000");

  assert.equal(store.validate(sessionToken, "http://localhost:4000"), false);
});

test("validate() returns false for an expired session", async () => {
  const store = new LocalSessionStore(0.05); // 50 ms TTL
  const { sessionToken } = store.create("http://localhost:3000");

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(store.validate(sessionToken, "http://localhost:3000"), false);
});

test("validate() returns false for an unknown token", () => {
  const store = new LocalSessionStore();
  store.create("http://localhost:3000");

  assert.equal(
    store.validate("not-a-real-token", "http://localhost:3000"),
    false
  );
});

test("cleanup() removes expired sessions and returns the count removed", async () => {
  const store = new LocalSessionStore(0.05); // 50 ms TTL
  store.create("http://localhost:3000");
  store.create("http://localhost:3001");

  await new Promise((resolve) => setTimeout(resolve, 100));

  const removed = store.cleanup();
  assert.equal(removed, 2);
});

test("cleanup() does not remove non-expired sessions", async () => {
  const store = new LocalSessionStore();
  store.create("http://localhost:3000");
  store.create("http://localhost:3001");

  const removed = store.cleanup();
  assert.equal(removed, 0);
  assert.equal(store.activeCount, 2);
});

test("invalidateAll() clears all sessions", () => {
  const store = new LocalSessionStore();
  store.create("http://localhost:3000");
  store.create("http://localhost:3001");
  assert.equal(store.activeCount, 2);

  store.invalidateAll();
  assert.equal(store.activeCount, 0);
});

test("creating a 9th session evicts the oldest one", () => {
  const store = new LocalSessionStore();

  const firstToken = store.create("http://localhost:3000").sessionToken;

  for (let i = 1; i < 8; i++) {
    store.create(`http://localhost:${3000 + i}`);
  }

  assert.equal(store.activeCount, 8);
  assert.equal(
    store.validate(firstToken, "http://localhost:3000"),
    true,
    "first token should still be valid before eviction"
  );

  // Creating the 9th session should evict the oldest (the first one)
  store.create("http://localhost:3009");

  assert.equal(store.activeCount, 8);
  assert.equal(
    store.validate(firstToken, "http://localhost:3000"),
    false,
    "first token should have been evicted"
  );
});

test("activeCount reflects only non-expired sessions", async () => {
  const shortTtlStore = new LocalSessionStore(0.05); // 50 ms TTL
  const longTtlStore = new LocalSessionStore();

  // Add two sessions to the short-TTL store
  shortTtlStore.create("http://localhost:3000");
  shortTtlStore.create("http://localhost:3001");

  // Add a session to a separate long-TTL store to confirm it is not affected
  longTtlStore.create("http://localhost:3000");

  assert.equal(shortTtlStore.activeCount, 2);
  assert.equal(longTtlStore.activeCount, 1);

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(shortTtlStore.activeCount, 0);
  assert.equal(longTtlStore.activeCount, 1);
});
