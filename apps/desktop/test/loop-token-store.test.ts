import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseJwtExpiry } from "../src/main/jwt-utils.js";
import { LoopTokenStore } from "../src/main/loop-token-store.js";
import {
  createTestLoopTokenMeta,
  createTestLoopTokenSafeStorage,
  makeFakeJwt,
} from "./loop-token-test-utils.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-token-store-test-"));
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("LoopTokenStore roundtrip and delete", () => {
  const store = new LoopTokenStore({
    cwd: tempRoot,
    name: "lt-store",
    safeStorage: createTestLoopTokenSafeStorage(),
  });
  assert.equal(store.getLoopToken("loop-a"), null);
  store.setLoopToken("loop-a", { token: "runner-secret" });
  assert.deepEqual(store.getLoopToken("loop-a"), { token: "runner-secret" });
  store.deleteLoopToken("loop-a");
  assert.equal(store.getLoopToken("loop-a"), null);
});

test("LoopTokenStore delete is idempotent", () => {
  const store = new LoopTokenStore({
    cwd: tempRoot,
    name: "lt-idem",
    safeStorage: createTestLoopTokenSafeStorage(),
  });
  store.deleteLoopToken("missing");
  assert.equal(store.getLoopToken("missing"), null);
});

test("LoopTokenStore listLoopIds reflects set and delete", () => {
  const store = new LoopTokenStore({
    cwd: tempRoot,
    name: "lt-list",
    safeStorage: createTestLoopTokenSafeStorage(),
  });
  assert.deepEqual(store.listLoopIds(), []);
  store.setLoopToken("loop-a", { token: "token-a" });
  store.setLoopToken("loop-b", { token: "token-b" });
  assert.deepEqual(store.listLoopIds().sort(), ["loop-a", "loop-b"]);
  store.deleteLoopToken("loop-a");
  assert.deepEqual(store.listLoopIds(), ["loop-b"]);
});

test("LoopTokenStore roundtrip with full LoopTokenMeta fields", () => {
  const store = new LoopTokenStore({
    cwd: tempRoot,
    name: "lt-meta",
    safeStorage: createTestLoopTokenSafeStorage(),
  });
  const meta = createTestLoopTokenMeta();
  store.setLoopToken("loop-x", meta);
  const result = store.getLoopToken("loop-x");
  assert.deepEqual(result, meta);
  assert.equal(result?.expiresAt, 1_700_000_000_000);
  assert.equal(result?.jti, "test-jti-abc123");
  assert.equal(result?.lastIdempotencyKey, "test-idempotency-key-xyz");
});

test("LoopTokenStore getLoopTokenString returns raw token string", () => {
  const store = new LoopTokenStore({
    cwd: tempRoot,
    name: "lt-str",
    safeStorage: createTestLoopTokenSafeStorage(),
  });
  assert.equal(store.getLoopTokenString("missing"), null);
  store.setLoopToken(
    "loop-s",
    createTestLoopTokenMeta({ token: "raw-token-value" })
  );
  assert.equal(store.getLoopTokenString("loop-s"), "raw-token-value");
});

// ---------------------------------------------------------------------------
// Boundary-validation tests (AC-001, AC-002)
// ---------------------------------------------------------------------------

test("LoopTokenStore getLoopToken returns null for valid JSON missing string token", () => {
  // Regression: PR #237 removed the parsed-object guard; a corrupt entry that
  // parses to JSON but lacks a string `token` must resolve to null, not a
  // LoopTokenMeta with undefined .token.
  const corruptPayloads = [
    "{}",
    '{"token":123}',
    '{"token":null}',
    '{"other":"field"}',
    '"just-a-string"',
    "42",
  ];
  for (const payload of corruptPayloads) {
    const store = new LoopTokenStore({
      cwd: tempRoot,
      name: `lt-corrupt-${Buffer.from(payload).toString("hex")}`,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(`stub:${s}`, "utf-8"),
        decryptString: () => payload,
      },
    });
    store.setLoopToken("loop-corrupt", { token: "placeholder" });
    assert.equal(
      store.getLoopToken("loop-corrupt"),
      null,
      `expected null for payload: ${payload}`
    );
  }
});

test("deleteLoopToken removes runner token", () => {
  const store = new LoopTokenStore({
    cwd: tempRoot,
    name: "lt-del-v2",
    safeStorage: createTestLoopTokenSafeStorage(),
  });
  store.setLoopToken("loop-a", { token: "runner" });
  store.deleteLoopToken("loop-a");
  assert.equal(
    store.getLoopToken("loop-a"),
    null,
    "runner token must be deleted"
  );
});

// ---------------------------------------------------------------------------
// parseJwtExpiry tests
// ---------------------------------------------------------------------------

test("parseJwtExpiry extracts numeric exp claim", () => {
  const token = makeFakeJwt({ sub: "user", exp: 1_700_000_000 });
  assert.equal(parseJwtExpiry(token), 1_700_000_000);
});

test("parseJwtExpiry returns null for missing exp claim", () => {
  const token = makeFakeJwt({ sub: "user" });
  assert.equal(parseJwtExpiry(token), null);
});

test("parseJwtExpiry returns null for non-numeric exp", () => {
  const token = makeFakeJwt({ exp: "not-a-number" });
  assert.equal(parseJwtExpiry(token), null);
});

test("parseJwtExpiry returns null for malformed token (wrong number of parts)", () => {
  assert.equal(parseJwtExpiry("only.two"), null);
  assert.equal(parseJwtExpiry("no-dots-at-all"), null);
});

test("parseJwtExpiry returns null for invalid base64url payload", () => {
  // Construct a token with a payload that is not valid base64url JSON.
  assert.equal(parseJwtExpiry("header.!!!invalid!!!.sig"), null);
});

test("parseJwtExpiry returns null for non-object JSON payload", () => {
  const header = Buffer.from("{}").toString("base64url");
  const arrayPayload = Buffer.from(JSON.stringify([1, 2, 3])).toString(
    "base64url"
  );
  assert.equal(parseJwtExpiry(`${header}.${arrayPayload}.sig`), null);
});
