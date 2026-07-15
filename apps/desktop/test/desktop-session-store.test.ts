import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  type DesktopSessionRecord,
  DesktopSessionStore,
} from "../src/main/desktop-session-store.js";
import type { SafeStorageLike } from "../src/main/electron-safe-storage.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-session-store-test-")
  );
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Obfuscating safeStorage stub: prefixes + base64 so the encrypted bytes never
 * contain the plaintext, letting the no-plaintext-at-rest test be meaningful.
 */
function createMockSafeStorage(): SafeStorageLike {
  const prefix = "enc:";
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) =>
      Buffer.from(
        `${prefix}${Buffer.from(plain, "utf8").toString("base64")}`,
        "utf8"
      ),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString("utf8");
      if (!raw.startsWith(prefix)) {
        throw new Error("bad ciphertext");
      }
      return Buffer.from(raw.slice(prefix.length), "base64").toString("utf8");
    },
  };
}

function createTestRecord(
  overrides: Partial<DesktopSessionRecord> = {}
): DesktopSessionRecord {
  return {
    refreshToken: "super-secret-refresh-token-ABC123",
    refreshTokenExpiresAt: "2026-07-30T00:00:00.000Z",
    userId: "user-1",
    organizationId: "org-1",
    gatewayId: "gateway-1",
    ...overrides,
  };
}

test("DesktopSessionStore roundtrips and clears a session", () => {
  const store = new DesktopSessionStore({
    cwd: tempRoot,
    name: "ds-roundtrip",
    safeStorage: createMockSafeStorage(),
  });
  assert.equal(store.getSession(), null);
  assert.equal(store.hasSession(), false);

  const record = createTestRecord();
  store.setSession(record);
  assert.equal(store.hasSession(), true);
  assert.deepEqual(store.getSession(), record);

  store.clear();
  assert.equal(store.getSession(), null);
  assert.equal(store.hasSession(), false);
});

test("DesktopSessionStore never writes the refresh token in plaintext", async () => {
  const store = new DesktopSessionStore({
    cwd: tempRoot,
    name: "ds-plaintext",
    safeStorage: createMockSafeStorage(),
  });
  const record = createTestRecord();
  store.setSession(record);

  const onDisk = await fs.readFile(
    path.join(tempRoot, "ds-plaintext.json"),
    "utf8"
  );
  assert.ok(
    !onDisk.includes(record.refreshToken),
    "plaintext refresh token must not appear on disk"
  );
  assert.ok(
    !onDisk.includes(record.userId),
    "plaintext user id must not appear on disk"
  );
  // Sanity: the encrypted blob is present and still decrypts back to the record.
  assert.ok(onDisk.includes("encryptedSession"));
  assert.deepEqual(store.getSession(), record);
});

test("DesktopSessionStore returns null for a corrupt or incomplete blob", () => {
  const corruptPayloads = [
    "{}",
    '{"refreshToken":"only"}',
    '{"refreshToken":123,"refreshTokenExpiresAt":"x","userId":"u","organizationId":"o","gatewayId":"g"}',
    '"just-a-string"',
    "not json",
    "",
  ];
  for (const payload of corruptPayloads) {
    const store = new DesktopSessionStore({
      cwd: tempRoot,
      name: `ds-corrupt-${Buffer.from(payload).toString("hex").slice(0, 12)}`,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(`x:${s}`, "utf8"),
        decryptString: () => payload,
      },
    });
    store.setSession(createTestRecord());
    assert.equal(
      store.getSession(),
      null,
      `expected null for payload: ${payload}`
    );
  }
});

test("DesktopSessionStore returns null when safeStorage cannot decrypt", () => {
  const store = new DesktopSessionStore({
    cwd: tempRoot,
    name: "ds-decrypt-fail",
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s, "utf8"),
      decryptString: () => {
        throw new Error("decrypt failed");
      },
    },
  });
  store.setSession(createTestRecord());
  assert.equal(store.getSession(), null);
});

test("DesktopSessionStore setSession throws when encryption is unavailable", () => {
  const store = new DesktopSessionStore({
    cwd: tempRoot,
    name: "ds-no-encryption",
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8"),
    },
  });
  assert.throws(() => store.setSession(createTestRecord()));
});
