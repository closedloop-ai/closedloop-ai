/**
 * @file api-key-store-cov-iss11283-branches.test.ts
 * @description ISS-11283 lane F — branch coverage for `ApiKeyStore`'s status,
 * diagnostic, and environment-variable fallback branches that had no
 * dedicated suite before this file (`ApiKeyStore` was previously exercised
 * only indirectly through IPC-handler tests).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/settings/api-key-store.js";

const SAFE_STORAGE_UNAVAILABLE_RE = /safeStorage is not available/;

const tempDirs: string[] = [];
let originalClosedloopKey: string | undefined;
let originalSymphonyKey: string | undefined;

beforeEach(() => {
  originalClosedloopKey = process.env.CLOSEDLOOP_API_KEY;
  originalSymphonyKey = process.env.SYMPHONY_API_KEY;
  Reflect.deleteProperty(process.env, "CLOSEDLOOP_API_KEY");
  Reflect.deleteProperty(process.env, "SYMPHONY_API_KEY");
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalClosedloopKey === undefined) {
    Reflect.deleteProperty(process.env, "CLOSEDLOOP_API_KEY");
  } else {
    process.env.CLOSEDLOOP_API_KEY = originalClosedloopKey;
  }
  if (originalSymphonyKey === undefined) {
    Reflect.deleteProperty(process.env, "SYMPHONY_API_KEY");
  } else {
    process.env.SYMPHONY_API_KEY = originalSymphonyKey;
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "api-key-store-cov-"));
  tempDirs.push(dir);
  return dir;
}

type FakeSafeStorageOptions = {
  encryptionAvailable?: boolean;
  decryptThrows?: boolean;
};

function makeFakeSafeStorage(
  options: FakeSafeStorageOptions = {}
): SafeStorageLike {
  return {
    isEncryptionAvailable: () => options.encryptionAvailable ?? true,
    encryptString(plainText: string): Buffer {
      return Buffer.from(`stub:${plainText}`, "utf-8");
    },
    decryptString(encrypted: Buffer): string {
      if (options.decryptThrows) {
        throw new Error("decryption failed");
      }
      const raw = encrypted.toString("utf-8");
      return raw.startsWith("stub:") ? raw.slice(5) : raw;
    },
  };
}

describe("ApiKeyStore default store name", () => {
  test("falls back to desktop-secrets.json when no name is given", () => {
    const cwd = makeTempDir();
    const store = new ApiKeyStore({
      cwd,
      safeStorage: makeFakeSafeStorage(),
    });

    store.setApiKey("sk_live_default_name");

    const fromDefaultFile = new ApiKeyStore({
      cwd,
      name: "desktop-secrets",
      safeStorage: makeFakeSafeStorage(),
    });
    expect(fromDefaultFile.getApiKey()).toBe("sk_live_default_name");
  });
});

describe("ApiKeyStore.getApiKeyRecord", () => {
  test("returns null when an encrypted key is stored but encryption is now unavailable", () => {
    const cwd = makeTempDir();
    const writer = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });
    writer.setApiKey("sk_live_locked_out");

    const reader = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage({ encryptionAvailable: false }),
    });

    expect(reader.getApiKeyRecord()).toBeNull();
  });
});

describe("ApiKeyStore.getApiKeyProvenance", () => {
  test("returns null when there is no stored or environment key", () => {
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });

    expect(store.getApiKeyProvenance()).toBeNull();
  });
});

describe("ApiKeyStore.getStatus", () => {
  test("reports source none when a stored key cannot be decrypted", () => {
    const cwd = makeTempDir();
    const writer = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });
    writer.setApiKey("sk_live_broken");

    const reader = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage({ decryptThrows: true }),
    });

    expect(reader.getStatus()).toEqual({
      hasApiKey: false,
      source: "none",
      provenance: undefined,
    });
  });

  test("reports the environment source when no key is stored", () => {
    process.env.CLOSEDLOOP_API_KEY = "env-primary-key";
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });

    expect(store.getStatus()).toEqual({
      hasApiKey: true,
      source: "environment",
      environmentVariable: "CLOSEDLOOP_API_KEY",
      provenance: "USER_CREATED",
    });
  });

  test("falls back to SYMPHONY_API_KEY when CLOSEDLOOP_API_KEY is unset", () => {
    process.env.SYMPHONY_API_KEY = "env-secondary-key";
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });

    const status = store.getStatus();
    expect(status.hasApiKey).toBe(true);
    expect(status.environmentVariable).toBe("SYMPHONY_API_KEY");
  });

  test("reports no key at all when nothing is stored and no environment key is set", () => {
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });

    expect(store.getStatus()).toEqual({
      hasApiKey: false,
      source: "none",
    });
  });
});

describe("ApiKeyStore.getApiKeyDiagnostic", () => {
  test("is available when a stored key decrypts successfully", () => {
    const cwd = makeTempDir();
    const store = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });
    store.setApiKey("sk_live_decryptable");

    expect(store.getApiKeyDiagnostic()).toBe("available");
  });

  test("is undecryptable when a stored key fails to decrypt", () => {
    const cwd = makeTempDir();
    const writer = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });
    writer.setApiKey("sk_live_undecryptable");

    const reader = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage({ decryptThrows: true }),
    });

    expect(reader.getApiKeyDiagnostic()).toBe("undecryptable");
  });

  test("is available when no key is stored but an environment key exists", () => {
    process.env.CLOSEDLOOP_API_KEY = "env-diagnostic-key";
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });

    expect(store.getApiKeyDiagnostic()).toBe("available");
  });

  test("is missing when there is no stored key and no environment key", () => {
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });

    expect(store.getApiKeyDiagnostic()).toBe("missing");
  });
});

describe("ApiKeyStore encryption-unavailable write guards", () => {
  test("setApiKey throws when safeStorage encryption is unavailable", () => {
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage({ encryptionAvailable: false }),
    });

    expect(() => store.setApiKey("sk_live_x")).toThrow(
      SAFE_STORAGE_UNAVAILABLE_RE
    );
  });

  test("saveProfileKey throws when safeStorage encryption is unavailable", () => {
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage({ encryptionAvailable: false }),
    });

    expect(() => store.saveProfileKey("profile-1", "sk_live_x")).toThrow(
      SAFE_STORAGE_UNAVAILABLE_RE
    );
  });
});

describe("ApiKeyStore.getProfileKeyRecord", () => {
  test("returns null when a saved profile key cannot be decrypted because encryption is unavailable", () => {
    const cwd = makeTempDir();
    const writer = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });
    writer.saveProfileKey("profile-locked", "sk_live_profile");

    const reader = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage({ encryptionAvailable: false }),
    });

    expect(reader.getProfileKeyRecord("profile-locked")).toBeNull();
  });

  test("returns null for a profile that was never saved", () => {
    const store = new ApiKeyStore({
      cwd: makeTempDir(),
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });

    expect(store.getProfileKeyRecord("never-saved")).toBeNull();
  });

  test("round-trips a saved profile key with its default provenance", () => {
    const cwd = makeTempDir();
    const store = new ApiKeyStore({
      cwd,
      name: "secrets",
      safeStorage: makeFakeSafeStorage(),
    });
    store.saveProfileKey("profile-ok", "sk_live_profile_ok");

    const record = store.getProfileKeyRecord("profile-ok");

    expect(record).toEqual({
      apiKey: "sk_live_profile_ok",
      provenance: "USER_CREATED",
    });
  });
});
