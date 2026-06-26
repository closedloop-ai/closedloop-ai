/**
 * @file approval-store.test.ts
 * @description Unit tests for the main-owned human-in-the-loop approval gate,
 * src/main/approval-store.ts. The ApprovalStore is security-critical: it
 * deduplicates pending approval requests by fingerprint, blocks gateway
 * operations until a human resolves them, and persists/rehydrates the pending
 * queue through electron-store.
 *
 * Reviewed invariants:
 *   (1) fingerprint() is a stable sha256 of method+path+body (method
 *       case-insensitive) so identical requests collide deterministically;
 *   (2) enqueue() returns the existing pending entry on a fingerprint
 *       collision instead of creating a duplicate;
 *   (3) waitForDecision() resolves "denied" for an unknown id and resolves
 *       "expired" once the timeout elapses;
 *   (4) resolveAndRemove() (via approve/deny) notifies every waiter and caps
 *       the resolved history at MAX_RESOLVED = 50, newest-first;
 *   (5) the constructor drops malformed persisted entries on rehydration.
 *
 * The production ApprovalStore hardcodes its electron-store name and does not
 * accept a cwd override, so it writes to a single shared store file. node:test
 * isolates each test FILE in its own process and runs the top-level tests in
 * this file sequentially, so each test resets the shared state (clear() +
 * clearResolved()) in beforeEach/afterEach to stay independent.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import Store from "electron-store";
import { ApprovalStore } from "../src/main/approval-store.js";
import type { RiskTier } from "../src/shared/contracts.js";

const APPROVAL_STORE_NAME = "desktop-approvals";
const MAX_RESOLVED = 50;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type EnqueueInput = {
  operationId: string;
  riskTier: Exclude<RiskTier, "none">;
  method: string;
  path: string;
  body: string;
  scopePath?: string;
  location: string;
  reason: string;
};

function makeEnqueueInput(overrides?: Partial<EnqueueInput>): EnqueueInput {
  return {
    operationId: "deploy",
    riskTier: "high",
    method: "POST",
    path: "/api/gateway/deploy",
    body: '{"ref":"main"}',
    location: "Local Desktop",
    reason: "Deploy requested",
    ...overrides,
  };
}

/** Reset the shared electron-store file so each test starts clean. */
function resetApprovalStoreFile(): void {
  const store = new Store<{ pending: unknown[] }>({
    name: APPROVAL_STORE_NAME,
    defaults: { pending: [] },
  });
  store.set("pending", []);
}

beforeEach(() => {
  resetApprovalStoreFile();
});

afterEach(() => {
  mock.timers.reset();
  resetApprovalStoreFile();
});

// --- fingerprint() ---

test("fingerprint produces identical sha256 for the same method+path+body", () => {
  const a = ApprovalStore.fingerprint("POST", "/api/gateway/deploy", "body");
  const b = ApprovalStore.fingerprint("POST", "/api/gateway/deploy", "body");

  assert.equal(a, b);
  // sha256 hex digest is 64 lowercase hex chars.
  assert.match(a, SHA256_HEX);
});

test("fingerprint normalizes method case but distinguishes path and body", () => {
  const upper = ApprovalStore.fingerprint("post", "/x", "b");
  const lower = ApprovalStore.fingerprint("POST", "/x", "b");
  assert.equal(upper, lower);

  const differentPath = ApprovalStore.fingerprint("POST", "/y", "b");
  const differentBody = ApprovalStore.fingerprint("POST", "/x", "c");
  assert.notEqual(lower, differentPath);
  assert.notEqual(lower, differentBody);
});

// --- enqueue() fingerprint deduplication ---

test("enqueue returns the existing pending entry on a fingerprint collision", () => {
  const store = new ApprovalStore();

  const first = store.enqueue(makeEnqueueInput());
  const second = store.enqueue(
    makeEnqueueInput({
      // Same method/path/body => same fingerprint. Other fields differ but
      // must NOT create a duplicate.
      operationId: "deploy",
      reason: "second request for the same operation",
    })
  );

  assert.equal(second.id, first.id);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(store.countPending(), 1);
  // The original entry (not the second call's fields) is preserved.
  assert.equal(second.reason, first.reason);
});

test("enqueue creates distinct entries for distinct fingerprints", () => {
  const store = new ApprovalStore();

  const a = store.enqueue(makeEnqueueInput({ path: "/api/gateway/deploy/a" }));
  const b = store.enqueue(makeEnqueueInput({ path: "/api/gateway/deploy/b" }));

  assert.notEqual(a.id, b.id);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(store.countPending(), 2);
});

test("enqueue uppercases the persisted method and computes the fingerprint", () => {
  const store = new ApprovalStore();

  const entry = store.enqueue(makeEnqueueInput({ method: "post" }));

  assert.equal(entry.method, "POST");
  assert.equal(
    entry.fingerprint,
    ApprovalStore.fingerprint("post", entry.path, '{"ref":"main"}')
  );
});

// --- waitForDecision() ---

test("waitForDecision resolves denied for an unknown approval id", async () => {
  const store = new ApprovalStore();

  const decision = await store.waitForDecision("does-not-exist", 1000);

  assert.equal(decision, "denied");
});

test("waitForDecision resolves with the decision when the approval is approved", async () => {
  const store = new ApprovalStore();
  const pending = store.enqueue(makeEnqueueInput());

  const decisionPromise = store.waitForDecision(pending.id, 60_000);
  store.approve(pending.id);

  assert.equal(await decisionPromise, "approved");
});

test("waitForDecision resolves expired once the timeout elapses", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const store = new ApprovalStore();
  const pending = store.enqueue(makeEnqueueInput());

  const decisionPromise = store.waitForDecision(pending.id, 5000);

  mock.timers.tick(5000);

  assert.equal(await decisionPromise, "expired");
  // Expiry removes the entry from the pending queue.
  assert.equal(store.countPending(), 0);
  assert.equal(store.getPendingById(pending.id), null);
});

// --- resolveAndRemove() waiter fan-out + history cap ---

test("resolveAndRemove notifies all waiters for the same approval", async () => {
  const store = new ApprovalStore();
  const pending = store.enqueue(makeEnqueueInput());

  const first = store.waitForDecision(pending.id, 60_000);
  const second = store.waitForDecision(pending.id, 60_000);

  const resolved = store.deny(pending.id);

  assert.equal(resolved?.id, pending.id);
  assert.deepEqual(await Promise.all([first, second]), ["denied", "denied"]);
  // The resolution moves the entry into history and out of pending.
  assert.equal(store.countPending(), 0);
  const history = store.listResolved();
  assert.equal(history[0]?.id, pending.id);
  assert.equal(history[0]?.decision, "denied");
});

test("resolveAndRemove caps resolved history at MAX_RESOLVED newest-first", () => {
  const store = new ApprovalStore();

  const total = MAX_RESOLVED + 10;
  let lastFingerprint = "";
  for (let i = 0; i < total; i += 1) {
    const entry = store.enqueue(
      makeEnqueueInput({ path: `/api/gateway/deploy/${i}` })
    );
    lastFingerprint = entry.fingerprint;
    store.approve(entry.id);
  }

  const history = store.listResolved();
  assert.equal(history.length, MAX_RESOLVED);
  // unshift keeps newest-first, so the final approval is at index 0.
  assert.equal(history[0]?.fingerprint, lastFingerprint);
  assert.equal(history[0]?.decision, "approved");
  assert.equal(store.countPending(), 0);
});

test("approve/deny return null for an unknown id and do not touch history", () => {
  const store = new ApprovalStore();

  assert.equal(store.approve("missing"), null);
  assert.equal(store.deny("missing"), null);
  assert.equal(store.listResolved().length, 0);
});

// --- constructor rehydration drops malformed entries ---

test("constructor drops malformed persisted entries on rehydration", () => {
  const seed = new Store<{ pending: unknown[] }>({
    name: APPROVAL_STORE_NAME,
    defaults: { pending: [] },
  });

  const validEntry = {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date().toISOString(),
    operationId: "deploy",
    riskTier: "high",
    method: "POST",
    path: "/api/gateway/deploy",
    location: "Local Desktop",
    reason: "rehydrated",
    fingerprint: ApprovalStore.fingerprint("POST", "/api/gateway/deploy", "b"),
  };

  seed.set("pending", [
    validEntry,
    null,
    { id: 42, fingerprint: "no-string-id" },
    { id: "missing-fingerprint" },
    { fingerprint: "missing-id" },
    "not-an-object",
  ]);

  const store = new ApprovalStore();

  assert.equal(store.countPending(), 1);
  const pending = store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, validEntry.id);
  assert.equal(store.getPendingById(validEntry.id)?.reason, "rehydrated");
});

test("constructor tolerates a non-array persisted pending value", () => {
  const seed = new Store<{ pending: unknown }>({
    name: APPROVAL_STORE_NAME,
    defaults: { pending: [] },
  });
  seed.set("pending", { not: "an array" } as unknown as unknown[]);

  const store = new ApprovalStore();

  assert.equal(store.countPending(), 0);
});
