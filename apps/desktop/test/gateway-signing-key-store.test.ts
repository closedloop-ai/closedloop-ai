import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { SafeStorageLike } from "../src/main/api-key-store.js";
import { GatewaySigningKeyStore } from "../src/main/gateway-signing-key-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gateway-signing-key-store-")
  );
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

describe("GatewaySigningKeyStore", () => {
  test("creates one encrypted Ed25519 keypair per gatewayId and rehydrates it", () => {
    const tmpDir = makeTempDir();
    const safeStorage = makeSafeStorage();
    const firstStore = new GatewaySigningKeyStore({
      cwd: tmpDir,
      name: "gateway-keys",
      safeStorage,
    });

    const first = firstStore.getOrCreate("gateway-1");
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.match(first.keyPair.publicKeySpkiPem, /BEGIN PUBLIC KEY/);
    assert.match(first.keyPair.privateKeyPkcs8Pem, /BEGIN PRIVATE KEY/);

    const persisted = readAllFiles(tmpDir);
    assert.equal(
      persisted.includes(first.keyPair.privateKeyPkcs8Pem),
      false,
      "plaintext private key must never be written to disk"
    );
    assert.equal(
      persisted.includes("BEGIN PRIVATE KEY"),
      false,
      "disk state must not include PEM private key markers"
    );

    const secondStore = new GatewaySigningKeyStore({
      cwd: tmpDir,
      name: "gateway-keys",
      safeStorage,
    });
    const second = secondStore.getOrCreate("gateway-1");
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.keyPair.gatewayId, "gateway-1");
    assert.equal(
      second.keyPair.publicKeySpkiPem,
      first.keyPair.publicKeySpkiPem
    );
    assert.equal(
      second.keyPair.privateKeyPkcs8Pem,
      first.keyPair.privateKeyPkcs8Pem
    );
  });

  test("load does not create replacement keys in runtime request paths", () => {
    const store = new GatewaySigningKeyStore({
      cwd: makeTempDir(),
      name: "gateway-keys",
      safeStorage: makeSafeStorage(),
    });

    const missing = store.load("gateway-1");

    assert.deepEqual(missing, { ok: false, reason: "key_missing" });
  });

  test("delete removes only the requested gateway key", () => {
    const store = new GatewaySigningKeyStore({
      cwd: makeTempDir(),
      name: "gateway-keys",
      safeStorage: makeSafeStorage(),
    });
    const first = store.getOrCreate("gateway-1");
    const second = store.getOrCreate("gateway-2");
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    store.delete("gateway-1");

    assert.deepEqual(store.load("gateway-1"), {
      ok: false,
      reason: "key_missing",
    });
    assert.equal(store.load("gateway-2").ok, true);
  });

  test("safeStorage unavailable returns a redacted failure reason", () => {
    const store = new GatewaySigningKeyStore({
      cwd: makeTempDir(),
      name: "gateway-keys",
      safeStorage: makeSafeStorage(false),
    });

    const result = store.getOrCreate("gateway-1");

    assert.deepEqual(result, { ok: false, reason: "safe_storage_unavailable" });
  });
});
