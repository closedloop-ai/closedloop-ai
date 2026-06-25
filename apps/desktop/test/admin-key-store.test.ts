/**
 * @file admin-key-store.test.ts
 * @description Unit tests for the main-owned vendor Admin API key persistence
 * (FEA-1435/1436), src/main/admin-key-store.ts.
 *
 * Reviewed invariants: (1) a set key round-trips through getKey() and reports
 * hasKey via the existence-only getStatus(); (2) the plaintext key is NEVER
 * written to disk — only the encrypted blob — so a leaked store file cannot
 * expose the secret; (3) the two vendors are namespaced within one store file
 * so setting/clearing one never disturbs the other; (4) clearKey() removes the
 * key; (5) safeStorage being unavailable degrades safely (setKey throws, getKey
 * returns null) rather than persisting plaintext. Each test isolates an
 * electron-store in a temp dir with an injected fake safeStorage.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  AdminKeyStore,
  createAnthropicAdminKeyStore,
  createOpenAiAdminKeyStore,
  type SafeStorageLike,
} from "../src/main/admin-key-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-key-store-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeSafeStorage(encryptionAvailable = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString(plainText: string) {
      return Buffer.from(
        `encrypted:${Buffer.from(plainText, "utf-8").toString("base64")}`,
        "utf-8"
      );
    },
    decryptString(encrypted: Buffer) {
      const raw = encrypted.toString("utf-8");
      assert.ok(
        raw.startsWith("encrypted:"),
        "test ciphertext should use encrypted prefix"
      );
      return Buffer.from(raw.slice("encrypted:".length), "base64").toString(
        "utf-8"
      );
    },
  };
}

function readAllFiles(dir: string): string {
  let out = "";
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const filePath = path.join(dir, String(entry));
    if (fs.statSync(filePath).isFile()) {
      out += fs.readFileSync(filePath, "utf-8");
    }
  }
  return out;
}

test("set/getKey round-trips and getStatus reports existence only", () => {
  const dir = makeTempDir();
  const store = new AdminKeyStore({
    vendor: "anthropic",
    cwd: dir,
    safeStorage: makeSafeStorage(),
  });

  assert.deepEqual(store.getStatus(), { vendor: "anthropic", hasKey: false });
  assert.equal(store.getKey(), null);

  store.setKey("sk-ant-admin-EXAMPLE");
  assert.equal(store.getKey(), "sk-ant-admin-EXAMPLE");
  assert.deepEqual(store.getStatus(), { vendor: "anthropic", hasKey: true });
});

test("plaintext key is never written to disk; only the encrypted blob", () => {
  const dir = makeTempDir();
  const store = createAnthropicAdminKeyStore({
    cwd: dir,
    safeStorage: makeSafeStorage(),
  });
  store.setKey("sk-ant-admin-SECRET-VALUE");

  const persisted = readAllFiles(dir);
  assert.equal(
    persisted.includes("sk-ant-admin-SECRET-VALUE"),
    false,
    "plaintext admin key must never be written to disk"
  );
  // The encrypted blob (base64 of the fake ciphertext) is what gets persisted.
  assert.ok(persisted.length > 0, "an encrypted blob should be persisted");
});

test("a fresh instance rehydrates the persisted key", () => {
  const dir = makeTempDir();
  const first = createOpenAiAdminKeyStore({
    cwd: dir,
    safeStorage: makeSafeStorage(),
  });
  first.setKey("sk-admin-OPENAI-EXAMPLE");

  const second = createOpenAiAdminKeyStore({
    cwd: dir,
    safeStorage: makeSafeStorage(),
  });
  assert.equal(second.getKey(), "sk-admin-OPENAI-EXAMPLE");
  assert.equal(second.getStatus().hasKey, true);
});

test("the two vendors are namespaced and do not collide", () => {
  const dir = makeTempDir();
  const safeStorage = makeSafeStorage();
  const anthropic = createAnthropicAdminKeyStore({ cwd: dir, safeStorage });
  const openai = createOpenAiAdminKeyStore({ cwd: dir, safeStorage });

  anthropic.setKey("sk-ant-admin-A");
  openai.setKey("sk-admin-O");

  assert.equal(anthropic.getKey(), "sk-ant-admin-A");
  assert.equal(openai.getKey(), "sk-admin-O");

  // Clearing one leaves the other intact.
  anthropic.clearKey();
  assert.equal(anthropic.getKey(), null);
  assert.equal(openai.getKey(), "sk-admin-O");
});

test("clearKey removes the stored key", () => {
  const dir = makeTempDir();
  const store = new AdminKeyStore({
    vendor: "openai",
    cwd: dir,
    safeStorage: makeSafeStorage(),
  });
  store.setKey("sk-admin-TO-CLEAR");
  assert.equal(store.getStatus().hasKey, true);

  store.clearKey();
  assert.equal(store.getStatus().hasKey, false);
  assert.equal(store.getKey(), null);
});

test("setKey rejects an empty or whitespace key", () => {
  const store = new AdminKeyStore({
    vendor: "anthropic",
    cwd: makeTempDir(),
    safeStorage: makeSafeStorage(),
  });
  assert.throws(() => store.setKey(""), /must not be empty/);
  assert.throws(() => store.setKey("   "), /must not be empty/);
  assert.equal(store.getStatus().hasKey, false);
});

test("setKey trims surrounding whitespace before persisting", () => {
  const store = new AdminKeyStore({
    vendor: "anthropic",
    cwd: makeTempDir(),
    safeStorage: makeSafeStorage(),
  });
  store.setKey("  sk-ant-admin-PADDED  ");
  assert.equal(store.getKey(), "sk-ant-admin-PADDED");
});

test("setKey rejects a key with control characters and persists nothing", () => {
  // A key carrying an embedded newline (e.g. a corrupted paste) is later placed
  // in an HTTP header value; fetch then throws an "invalid header value" error
  // that ECHOES the raw key. Reject such keys at this IPC boundary so the value
  // can never reach that leak path — and confirm the rejection error itself does
  // not contain the key.
  const dir = makeTempDir();
  const store = new AdminKeyStore({
    vendor: "anthropic",
    cwd: dir,
    safeStorage: makeSafeStorage(),
  });

  const badKey = "sk-ant-admin-SECRET\nINJECTED";
  assert.throws(
    () => store.setKey(badKey),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /contains invalid characters/);
      // The rejection message must never echo the key material.
      assert.ok(!err.message.includes("SECRET"));
      return true;
    }
  );
  assert.equal(store.getKey(), null);
  assert.equal(store.getStatus().hasKey, false);
  // Nothing — encrypted or plaintext — was persisted for the rejected key.
  assert.equal(readAllFiles(dir).includes("SECRET"), false);

  // A tab and a raw non-ASCII byte are likewise rejected.
  assert.throws(
    () => store.setKey("sk-ant-admin-\tTAB"),
    /contains invalid characters/
  );
  assert.throws(
    () => store.setKey("sk-ant-admin-café"),
    /contains invalid characters/
  );

  // A normal key with only visible ASCII still saves.
  store.setKey("sk-ant-admin-OK_value-123");
  assert.equal(store.getKey(), "sk-ant-admin-OK_value-123");
});

test("safeStorage unavailable: setKey throws and nothing is persisted", () => {
  const dir = makeTempDir();
  const store = new AdminKeyStore({
    vendor: "anthropic",
    cwd: dir,
    safeStorage: makeSafeStorage(false),
  });

  assert.throws(
    () => store.setKey("sk-ant-admin-X"),
    /safeStorage is not available/
  );
  assert.equal(store.getKey(), null);
  assert.equal(store.getStatus().hasKey, false);
});
