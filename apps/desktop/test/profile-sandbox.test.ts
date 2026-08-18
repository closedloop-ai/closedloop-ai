import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  ProfileConfigIpcChannel,
  registerProfileConfigIpcHandlers,
} from "../src/main/ipc/profile-config-ipc.js";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";

/**
 * FEA-4005: the per-profile sandbox base directory. Covers the store round-trip
 * (persist on save, apply → global scope root, absent → global fallback), the
 * shared FEA-3641 risky-root rejection at this new edit point, and the IPC
 * re-seed side effect firing only when applying/saving a profile actually
 * changed the global sandbox.
 */

const SAFE_SANDBOX = "/workspace/projects";
const OTHER_SAFE_SANDBOX = "/workspace/other-repos";
const GLOBAL_SANDBOX = "/workspace/global";

const RISKY_ROOT_RE = /home directory or a system root/i;
const REQUIRED_RE = /required/i;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSettings(tmpDir: string, name = "settings"): SettingsStore {
  return new SettingsStore({ cwd: tmpDir, name });
}

function makeTestSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plainText: string) {
      return Buffer.from(`stub:${plainText}`, "utf-8");
    },
    decryptString(encrypted: Buffer) {
      const s = encrypted.toString("utf-8");
      return s.startsWith("stub:") ? s.slice(5) : s;
    },
  };
}

function makeApiKeyStore(tmpDir: string): ApiKeyStore {
  return new ApiKeyStore({
    cwd: tmpDir,
    name: "secrets",
    safeStorage: makeTestSafeStorage(),
  });
}

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

function registerHandlers(
  settingsStore: SettingsStore,
  apiKeyStore: ApiKeyStore,
  seededSandboxes: string[]
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerProfileConfigIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: () => true,
      settingsStore,
      apiKeyStore,
      getGatewaySnapshot: () => ({ gatewayPort: null, computeTarget: null }),
      cancelManagedOnboardingForUserChange: () => {},
      onActiveConfigDeleted: () => {},
      onConfigDeleted: () => {},
      restartCloudSocket: () => {},
      isEncryptionAvailable: () => true,
      seedReposConfig: (sandboxBaseDirectory) => {
        seededSandboxes.push(sandboxBaseDirectory);
        return Promise.resolve();
      },
    }
  );
  return handlers;
}

// --- store: saveConfig / updateConfigConnection round-trip ---

test("saveConfig persists a valid per-profile sandbox base directory", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-save-"));

  const config = store.saveConfig("Production", {
    sandboxBaseDirectory: SAFE_SANDBOX,
  });

  assert.equal(config.sandboxBaseDirectory, SAFE_SANDBOX);
  assert.equal(store.listConfigs()[0].sandboxBaseDirectory, SAFE_SANDBOX);
});

test("saveConfig omits the sandbox field when none is provided", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-absent-"));

  const config = store.saveConfig("Production");

  assert.equal(config.sandboxBaseDirectory, undefined);
  assert.ok(
    !("sandboxBaseDirectory" in store.listConfigs()[0]),
    "absent sandbox must not be serialized onto the profile"
  );
});

test("saveConfig rejects a risky-root sandbox (FEA-3641) and creates nothing", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-risky-save-"));

  assert.throws(
    () => store.saveConfig("Production", { sandboxBaseDirectory: "/Users/me" }),
    RISKY_ROOT_RE
  );
  assert.deepEqual(store.listConfigs(), []);
});

test("saveConfig rejects an empty-string sandbox", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-empty-save-"));

  assert.throws(
    () => store.saveConfig("Production", { sandboxBaseDirectory: "   " }),
    REQUIRED_RE
  );
});

test("updateConfigConnection persists a valid sandbox and rejects a risky root", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-update-"));
  const config = store.saveConfig("Production");

  const updated = store.updateConfigConnection(config.id, {
    sandboxBaseDirectory: SAFE_SANDBOX,
  });
  assert.equal(updated.sandboxBaseDirectory, SAFE_SANDBOX);

  assert.throws(
    () =>
      store.updateConfigConnection(config.id, {
        sandboxBaseDirectory: "~",
      }),
    RISKY_ROOT_RE
  );
  // The rejected update must not have overwritten the previously-saved value.
  assert.equal(store.listConfigs()[0].sandboxBaseDirectory, SAFE_SANDBOX);
});

// --- store: applyConfig sandbox precedence ---

test("applyConfig applies a profile's sandbox to the global scope root", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-apply-"));
  store.setSandboxBaseDirectory(GLOBAL_SANDBOX);
  const config = store.saveConfig("Production", {
    sandboxBaseDirectory: SAFE_SANDBOX,
  });

  store.applyConfig(config.id);

  assert.equal(store.getSandboxBaseDirectory(), SAFE_SANDBOX);
});

test("applyConfig leaves the global sandbox untouched when the profile omits one", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-apply-fallback-"));
  store.setSandboxBaseDirectory(GLOBAL_SANDBOX);
  // Older profile persisted before the per-profile field existed.
  const config = store.saveConfig("Legacy");

  store.applyConfig(config.id);

  assert.equal(store.getSandboxBaseDirectory(), GLOBAL_SANDBOX);
});

test("ensureActiveConfigForCurrentOrigins does not clobber the global sandbox with a reused profile's sandbox", () => {
  const store = makeSettings(makeTempDir("profile-sandbox-reconcile-"));
  // A pre-existing profile matching the current origins that carries an old
  // per-profile sandbox.
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");
  store.saveConfig("Existing", { sandboxBaseDirectory: OTHER_SAFE_SANDBOX });
  store.setActiveConfigId(null);
  // Onboarding/settings has just persisted the user's chosen global sandbox.
  store.setSandboxBaseDirectory(GLOBAL_SANDBOX);

  store.ensureActiveConfigForCurrentOrigins();

  // Origin reconciliation must not overwrite the freshly-set global sandbox.
  assert.equal(store.getSandboxBaseDirectory(), GLOBAL_SANDBOX);
});

// --- IPC: re-seed side effect on sandbox change ---

test("applyConfig IPC re-seeds repos when the applied sandbox differs", () => {
  const tmpDir = makeTempDir("profile-sandbox-ipc-apply-seed-");
  const store = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  store.setSandboxBaseDirectory(GLOBAL_SANDBOX);
  const config = store.saveConfig("Production", {
    sandboxBaseDirectory: OTHER_SAFE_SANDBOX,
  });
  const seeded: string[] = [];
  const handlers = registerHandlers(store, apiKeyStore, seeded);
  const applyConfig = handlers.get(ProfileConfigIpcChannel.ApplyConfig);
  assert.ok(applyConfig);

  applyConfig(null, { id: config.id });

  assert.deepEqual(seeded, [OTHER_SAFE_SANDBOX]);
  assert.equal(store.getSandboxBaseDirectory(), OTHER_SAFE_SANDBOX);
});

test("applyConfig IPC does not re-seed when the sandbox is unchanged", () => {
  const tmpDir = makeTempDir("profile-sandbox-ipc-apply-noop-");
  const store = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  store.setSandboxBaseDirectory(SAFE_SANDBOX);
  // Profile carries the same sandbox already active globally.
  const config = store.saveConfig("Production", {
    sandboxBaseDirectory: SAFE_SANDBOX,
  });
  const seeded: string[] = [];
  const handlers = registerHandlers(store, apiKeyStore, seeded);
  const applyConfig = handlers.get(ProfileConfigIpcChannel.ApplyConfig);
  assert.ok(applyConfig);

  applyConfig(null, { id: config.id });

  assert.deepEqual(seeded, [], "no re-seed when the sandbox did not change");
});

test("saveConfig IPC re-seeds repos when creating+activating a profile with a new sandbox", () => {
  const tmpDir = makeTempDir("profile-sandbox-ipc-save-seed-");
  const store = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  store.setSandboxBaseDirectory(GLOBAL_SANDBOX);
  const seeded: string[] = [];
  const handlers = registerHandlers(store, apiKeyStore, seeded);
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  saveConfig(null, {
    name: "Production",
    relayOrigin: "https://relay.test",
    apiOrigin: "https://api.test",
    webAppOrigin: "https://app.test",
    sandboxBaseDirectory: OTHER_SAFE_SANDBOX,
  });

  assert.deepEqual(seeded, [OTHER_SAFE_SANDBOX]);
  assert.equal(store.getSandboxBaseDirectory(), OTHER_SAFE_SANDBOX);
});

test("saveConfig IPC rejects a risky-root sandbox before persisting", () => {
  const tmpDir = makeTempDir("profile-sandbox-ipc-risky-");
  const store = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const seeded: string[] = [];
  const handlers = registerHandlers(store, apiKeyStore, seeded);
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  assert.throws(
    () =>
      saveConfig(null, {
        name: "Production",
        relayOrigin: "https://relay.test",
        apiOrigin: "https://api.test",
        webAppOrigin: "https://app.test",
        sandboxBaseDirectory: "/Users/me",
      }),
    RISKY_ROOT_RE
  );
  assert.deepEqual(store.listConfigs(), []);
  assert.deepEqual(seeded, []);
});
test("saveConfig IPC drops a non-string sandbox instead of coercing it", () => {
  // FEA-4005 thread-10: a malformed IPC value (number/object/null) must NOT be
  // String()-coerced into a cwd-relative path and persisted as a valid sandbox.
  const tmpDir = makeTempDir("profile-sandbox-ipc-nonstring-");
  const store = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const seeded: string[] = [];
  const handlers = registerHandlers(store, apiKeyStore, seeded);
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  saveConfig(null, {
    name: "Production",
    relayOrigin: "https://relay.test",
    apiOrigin: "https://api.test",
    webAppOrigin: "https://app.test",
    // A number would String()-coerce to "42" and resolve under cwd.
    sandboxBaseDirectory: 42,
  });

  const persisted = store.listConfigs()[0];
  assert.equal("sandboxBaseDirectory" in persisted, false);
  // No sandbox change => nothing re-seeded.
  assert.deepEqual(seeded, []);
});
