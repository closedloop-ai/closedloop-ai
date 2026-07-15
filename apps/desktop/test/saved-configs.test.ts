import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/api-key-store.js";
import {
  PROFILE_CONFIG_IPC_CHANNELS,
  ProfileConfigIpcChannel,
  registerProfileConfigIpcHandlers,
} from "../src/main/profile-config-ipc.js";
import { SettingsStore } from "../src/main/settings-store.js";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function registerProfileHandlers(
  settingsStore: SettingsStore,
  apiKeyStore: ApiKeyStore,
  options: {
    gatewayPort?: number | null;
    computeTarget?: string | null;
    encryptionAvailable?: boolean;
    cancelReasons?: string[];
    restarts?: { count: number };
  } = {}
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
      getGatewaySnapshot: () => ({
        gatewayPort: options.gatewayPort ?? null,
        computeTarget: options.computeTarget ?? null,
      }),
      cancelManagedOnboardingForUserChange: (reason) => {
        options.cancelReasons?.push(reason);
      },
      onActiveConfigDeleted: () => {},
      onConfigDeleted: () => {},
      restartCloudSocket: () => {
        if (options.restarts) {
          options.restarts.count += 1;
        }
      },
      isEncryptionAvailable: () => options.encryptionAvailable ?? true,
    }
  );
  return handlers;
}

// --- saveConfig ---

test("saveConfig captures current relayOrigin, apiOrigin, webAppOrigin", () => {
  const tmpDir = makeTempDir("saved-configs-save-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  const config = store.saveConfig("my-config");

  assert.equal(config.relayOrigin, "https://relay.test");
  assert.equal(config.apiOrigin, "https://api.test");
  assert.equal(config.webAppOrigin, "https://app.test");
  assert.equal(config.name, "my-config");
  assert.match(config.id, UUID_V4_RE, "id should be UUID v4");
});

test("saveConfig can capture explicit profile connection settings", () => {
  const tmpDir = makeTempDir("saved-configs-save-explicit-");
  const store = makeSettings(tmpDir);

  const config = store.saveConfig("custom-gateway", {
    relayOrigin: "http://localhost:3020/socket",
    apiOrigin: "http://localhost:3002/v1",
    webAppOrigin: "http://localhost:3000/settings",
  });

  assert.equal(config.relayOrigin, "http://localhost:3020");
  assert.equal(config.apiOrigin, "http://localhost:3002");
  assert.equal(config.webAppOrigin, "http://localhost:3000");
});

test("saveConfig two consecutive saves produce distinct IDs", () => {
  const tmpDir = makeTempDir("saved-configs-ids-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  const a = store.saveConfig("alpha");
  const b = store.saveConfig("beta");

  assert.notEqual(a.id, b.id);
});

test("saveConfig with empty string name throws validation error", () => {
  const tmpDir = makeTempDir("saved-configs-empty-name-");
  const store = makeSettings(tmpDir);

  assert.throws(() => store.saveConfig(""), /name is required/i);
  assert.throws(() => store.saveConfig("   "), /name is required/i);
});

test("saveConfig with name longer than 200 chars throws", () => {
  const tmpDir = makeTempDir("saved-configs-long-name-");
  const store = makeSettings(tmpDir);

  assert.throws(() => store.saveConfig("x".repeat(201)), /200 characters/i);
});

test("saveConfig rejects duplicate name (case-insensitive, trimmed)", () => {
  const tmpDir = makeTempDir("saved-configs-dup-name-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  store.saveConfig("Production");

  assert.throws(() => store.saveConfig("Production"), /already exists/i);
  assert.throws(() => store.saveConfig("production"), /already exists/i);
  assert.throws(() => store.saveConfig("  PRODUCTION  "), /already exists/i);
  assert.equal(store.listConfigs().length, 1);
});

test("findConfigByOrigins returns the matching config or null", () => {
  const tmpDir = makeTempDir("saved-configs-find-origins-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");
  const prod = store.saveConfig("Production");

  store.setRelayOrigin("https://relay.staging.test");
  store.setApiOrigin("https://api.staging.test");
  store.setWebAppOrigin("https://app.staging.test");
  store.saveConfig("Staging");

  assert.equal(
    store.findConfigByOrigins(
      "https://relay.test",
      "https://api.test",
      "https://app.test"
    )?.id,
    prod.id
  );
  assert.equal(
    store.findConfigByOrigins(
      "https://relay.test",
      "https://api.test",
      "https://different.test"
    ),
    null
  );
});

test("ensureActiveConfigForCurrentOrigins creates and activates a default profile", () => {
  const tmpDir = makeTempDir("saved-configs-ensure-active-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.dev.test");
  store.setApiOrigin("https://api.dev.test");
  store.setWebAppOrigin("https://app.dev.test");

  const config = store.ensureActiveConfigForCurrentOrigins("Default");

  assert.equal(config.name, "Default");
  assert.equal(config.relayOrigin, "https://relay.dev.test");
  assert.equal(config.apiOrigin, "https://api.dev.test");
  assert.equal(config.webAppOrigin, "https://app.dev.test");
  assert.equal(store.getActiveConfigId(), config.id);
  assert.equal(store.listConfigs().length, 1);
});

test("ensureActiveConfigForCurrentOrigins syncs origins onto the active profile", () => {
  const tmpDir = makeTempDir("saved-configs-ensure-active-origins-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.old.test");
  store.setApiOrigin("https://api.old.test");
  store.setWebAppOrigin("https://app.old.test");
  const existing = store.saveConfig("Development");
  store.applyConfig(existing.id);
  store.setRelayOrigin("https://relay.new.test");
  store.setApiOrigin("https://api.new.test");
  store.setWebAppOrigin("https://app.new.test");

  const config = store.ensureActiveConfigForCurrentOrigins("Default");

  assert.equal(config.id, existing.id);
  assert.equal(config.relayOrigin, "https://relay.new.test");
  assert.equal(config.apiOrigin, "https://api.new.test");
  assert.equal(config.webAppOrigin, "https://app.new.test");
  assert.equal(store.listConfigs().length, 1);
});

test("ensureActiveConfigForCurrentOrigins reuses a matching saved profile", () => {
  const tmpDir = makeTempDir("saved-configs-ensure-reuse-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.dev.test");
  store.setApiOrigin("https://api.dev.test");
  store.setWebAppOrigin("https://app.dev.test");
  const existing = store.saveConfig("Development");

  const config = store.ensureActiveConfigForCurrentOrigins("Default");

  assert.equal(config.id, existing.id);
  assert.equal(config.name, "Development");
  assert.equal(store.getActiveConfigId(), existing.id);
  assert.equal(store.listConfigs().length, 1);
});

test("ensureActiveConfigForCurrentOrigins chooses an available default name", () => {
  const tmpDir = makeTempDir("saved-configs-ensure-name-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.one.test");
  store.setApiOrigin("https://api.one.test");
  store.setWebAppOrigin("https://app.one.test");
  store.saveConfig("Default");
  store.setRelayOrigin("https://relay.two.test");
  store.setApiOrigin("https://api.two.test");
  store.setWebAppOrigin("https://app.two.test");

  const config = store.ensureActiveConfigForCurrentOrigins("Default");

  assert.equal(config.name, "Default 2");
  assert.equal(store.getActiveConfigId(), config.id);
  assert.equal(store.listConfigs().length, 2);
});

// --- listConfigs ---

test("listConfigs returns configs in insertion order", () => {
  const tmpDir = makeTempDir("saved-configs-list-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  store.saveConfig("A");
  store.saveConfig("B");
  store.saveConfig("C");

  const configs = store.listConfigs();
  assert.equal(configs.length, 3);
  assert.equal(configs[0].name, "A");
  assert.equal(configs[1].name, "B");
  assert.equal(configs[2].name, "C");
});

// --- deleteConfig ---

test("deleteConfig non-active case returns wasActive: false and removes from listConfigs", () => {
  const tmpDir = makeTempDir("saved-configs-delete-non-active-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  const config = store.saveConfig("to-delete");
  const result = store.deleteConfig(config.id);

  assert.equal(result.wasActive, false);
  const remaining = store.listConfigs();
  assert.equal(remaining.length, 0);
});

test("deleteConfig active case returns wasActive: true and clears activeConfigId", () => {
  const tmpDir = makeTempDir("saved-configs-delete-active-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  const config = store.saveConfig("active-config");
  store.applyConfig(config.id);
  assert.equal(store.getActiveConfigId(), config.id);

  const result = store.deleteConfig(config.id);

  assert.equal(result.wasActive, true);
  assert.equal(store.getActiveConfigId(), null);
  assert.equal(store.listConfigs().length, 0);
  // Note: origin reset on active-config delete is done by the IPC handler (app.ts),
  // not by the data-layer deleteConfig method.
});

test("deleteConfig with unknown id returns wasActive: false without throwing", () => {
  const tmpDir = makeTempDir("saved-configs-delete-unknown-");
  const store = makeSettings(tmpDir);

  const result = store.deleteConfig("00000000-0000-4000-8000-000000000000");

  assert.equal(result.wasActive, false);
});

test("isGatewayIdReferenced preserves shared saved or active legacy gateway keys", () => {
  const tmpDir = makeTempDir("saved-configs-gateway-reference-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");
  const first = store.saveConfig("first");
  const second = store.saveConfig("second");

  store.updateConfigManagedMetadata(first.id, {
    apiKeySource: "DESKTOP_MANAGED",
    gatewayId: "gateway-shared",
  });
  store.updateConfigManagedMetadata(second.id, {
    apiKeySource: "DESKTOP_MANAGED",
    gatewayId: "gateway-shared",
  });

  store.deleteConfig(first.id);

  assert.equal(store.isGatewayIdReferenced("gateway-shared"), true);
  store.deleteConfig(second.id);
  assert.equal(store.isGatewayIdReferenced("gateway-shared"), false);
  assert.equal(
    store.isGatewayIdReferenced("gateway-shared", {
      activeRuntimeGatewayId: "gateway-shared",
    }),
    true
  );
});

// --- renameConfig ---

test("renameConfig persists to disk and preserves id", () => {
  const tmpDir = makeTempDir("saved-configs-rename-");
  const storeName = "rename-settings";
  const store = makeSettings(tmpDir, storeName);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  const config = store.saveConfig("original");
  store.renameConfig(config.id, "renamed");

  // Reconstruct store from same tmpDir to verify disk persistence
  const store2 = makeSettings(tmpDir, storeName);
  const configs = store2.listConfigs();
  assert.equal(configs.length, 1);
  assert.equal(configs[0].name, "renamed");
  assert.equal(configs[0].id, config.id);
});

test("renameConfig with unknown id throws error containing 'Config not found'", () => {
  const tmpDir = makeTempDir("saved-configs-rename-unknown-");
  const store = makeSettings(tmpDir);

  assert.throws(
    () =>
      store.renameConfig("00000000-0000-4000-8000-000000000000", "new-name"),
    /Config not found/
  );
});

test("renameConfig rejects a name already used by another config (case-insensitive)", () => {
  const tmpDir = makeTempDir("saved-configs-rename-dup-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  const a = store.saveConfig("Production");
  const b = store.saveConfig("Staging");

  assert.throws(
    () => store.renameConfig(b.id, "production"),
    /already exists/i
  );
  // Renaming to its own name (even different case / whitespace) is allowed
  store.renameConfig(a.id, "  Production  ");
  assert.equal(
    store.listConfigs().find((c) => c.id === a.id)?.name,
    "Production"
  );
});

test("updateConfigConnection persists selected profile endpoints and name", () => {
  const tmpDir = makeTempDir("saved-configs-update-connection-");
  const storeName = "connection-settings";
  const store = makeSettings(tmpDir, storeName);
  store.setRelayOrigin("https://relay.old.test");
  store.setApiOrigin("https://api.old.test");
  store.setWebAppOrigin("https://app.old.test");
  const config = store.saveConfig("Old");

  const updated = store.updateConfigConnection(config.id, {
    name: "Local",
    relayOrigin: "http://localhost:3020/socket",
    apiOrigin: "http://localhost:3002/v1",
    webAppOrigin: "http://localhost:3000/settings",
  });

  assert.equal(updated.name, "Local");
  assert.equal(updated.relayOrigin, "http://localhost:3020");
  assert.equal(updated.apiOrigin, "http://localhost:3002");
  assert.equal(updated.webAppOrigin, "http://localhost:3000");
  const rehydratedConfig = makeSettings(tmpDir, storeName)
    .listConfigs()
    .find((c) => c.id === config.id);
  assert.equal(rehydratedConfig?.name, "Local");
  assert.equal(rehydratedConfig?.relayOrigin, "http://localhost:3020");
  assert.equal(rehydratedConfig?.apiOrigin, "http://localhost:3002");
  assert.equal(rehydratedConfig?.webAppOrigin, "http://localhost:3000");
});

// --- applyConfig ---

test("applyConfig returns config, sets activeConfigId, and updates store origins", () => {
  const tmpDir = makeTempDir("saved-configs-apply-");
  const store = makeSettings(tmpDir);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");

  const config = store.saveConfig("apply-test");

  // Change current origins before applying
  store.setRelayOrigin("https://other-relay.test");
  store.setApiOrigin("https://other-api.test");
  store.setWebAppOrigin("https://other-app.test");

  const applied = store.applyConfig(config.id);

  assert.equal(applied.id, config.id);
  assert.equal(store.getActiveConfigId(), config.id);
  assert.equal(store.getRelayOrigin(), "https://relay.test");
  assert.equal(store.getApiOrigin(), "https://api.test");
  assert.equal(store.getWebAppOrigin(), "https://app.test");
});

test("applyConfig with unknown id throws error containing 'Config not found'", () => {
  const tmpDir = makeTempDir("saved-configs-apply-unknown-");
  const store = makeSettings(tmpDir);

  assert.throws(
    () => store.applyConfig("00000000-0000-4000-8000-000000000000"),
    /Config not found/
  );
});

// --- migration: fresh install initializes savedConfigs and activeConfigId ---

test("migration: fresh install initializes savedConfigs to [] and activeConfigId to null", () => {
  const tmpDir = makeTempDir("saved-configs-migration-");
  const storeName = "migration-fresh";
  // Seed a file with no savedConfigs/activeConfigId (simulates pre-feature install)
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ relayOrigin: "https://relay.example.test" })
  );

  const store = makeSettings(tmpDir, storeName);
  const all = store.getAll();

  assert.deepEqual(all.savedConfigs, []);
  assert.equal(all.activeConfigId, null);
});

test("migration: malformed savedConfigs is normalized to []", () => {
  const tmpDir = makeTempDir("saved-configs-malformed-migration-");
  const storeName = "migration-malformed";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ savedConfigs: null, activeConfigId: null }),
    "utf-8"
  );

  const store = makeSettings(tmpDir, storeName);

  assert.deepEqual(store.getAll().savedConfigs, []);
  assert.deepEqual(store.listConfigs(), []);
  assert.deepEqual(makeSettings(tmpDir, storeName).getAll().savedConfigs, []);
});

test("migration: malformed savedConfig entries are dropped", () => {
  const tmpDir = makeTempDir("saved-configs-malformed-entries-");
  const storeName = "migration-malformed-entries";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      savedConfigs: [
        null,
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "valid",
          relayOrigin: "https://relay.test",
          apiOrigin: "https://api.test",
          webAppOrigin: "https://app.test",
        },
      ],
      activeConfigId: null,
    }),
    "utf-8"
  );

  const store = makeSettings(tmpDir, storeName);

  assert.equal(store.listConfigs().length, 1);
  assert.equal(store.listConfigs()[0]?.name, "valid");
  assert.equal(makeSettings(tmpDir, storeName).listConfigs().length, 1);
});

test("migration: saved configs without managed identity are treated as USER_CREATED", () => {
  const tmpDir = makeTempDir("saved-configs-managed-migration-");
  const storeName = "migration-managed";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      savedConfigs: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "legacy",
          relayOrigin: "https://relay.test",
          apiOrigin: "https://api.test",
          webAppOrigin: "https://app.test",
          apiKeySource: "DESKTOP_MANAGED",
        },
      ],
      activeConfigId: null,
    }),
    "utf-8"
  );

  const store = makeSettings(tmpDir, storeName);

  assert.equal(store.listConfigs()[0]?.apiKeySource, "USER_CREATED");
});

test("ensureConfigGatewayId creates isolated persisted gateway identities", () => {
  const tmpDir = makeTempDir("saved-configs-gateway-id-");
  const storeName = "gateway-id-settings";
  const store = makeSettings(tmpDir, storeName);
  store.setRelayOrigin("https://relay.test");
  store.setApiOrigin("https://api.test");
  store.setWebAppOrigin("https://app.test");
  const first = store.saveConfig("first");
  const second = store.saveConfig("second");

  const firstWithGateway = store.ensureConfigGatewayId(first.id);
  const secondWithGateway = store.ensureConfigGatewayId(second.id);

  assert.match(firstWithGateway.gatewayId ?? "", UUID_V4_RE);
  assert.match(secondWithGateway.gatewayId ?? "", UUID_V4_RE);
  assert.notEqual(firstWithGateway.gatewayId, secondWithGateway.gatewayId);
  assert.equal(
    store.ensureConfigGatewayId(first.id).gatewayId,
    firstWithGateway.gatewayId
  );
  assert.equal(
    makeSettings(tmpDir, storeName)
      .listConfigs()
      .find((c) => c.id === first.id)?.gatewayId,
    firstWithGateway.gatewayId
  );
});

test("updateActiveConfigOrigins persists trusted origins on the active profile", () => {
  const tmpDir = makeTempDir("saved-configs-active-origins-");
  const storeName = "active-origins-settings";
  const store = makeSettings(tmpDir, storeName);
  store.setRelayOrigin("https://relay.old.test");
  store.setApiOrigin("https://api.old.test");
  store.setWebAppOrigin("https://app.old.test");
  const config = store.saveConfig("Dev");
  store.applyConfig(config.id);

  const updated = store.updateActiveConfigOrigins({
    relayOrigin: "http://localhost:3020/socket",
    apiOrigin: "http://localhost:3002/v1",
    webAppOrigin: "http://localhost:3000/settings",
  });

  assert.equal(updated?.relayOrigin, "http://localhost:3020");
  assert.equal(updated?.apiOrigin, "http://localhost:3002");
  assert.equal(updated?.webAppOrigin, "http://localhost:3000");
  const rehydrated = makeSettings(tmpDir, storeName);
  const rehydratedConfig = rehydrated
    .listConfigs()
    .find((c) => c.id === config.id);
  assert.equal(rehydratedConfig?.relayOrigin, "http://localhost:3020");
  assert.equal(rehydratedConfig?.apiOrigin, "http://localhost:3002");
  assert.equal(rehydratedConfig?.webAppOrigin, "http://localhost:3000");
});

// --- ApiKeyStore profile key methods ---

test("ApiKeyStore.saveProfileKey/getProfileKey/deleteProfileKey roundtrip", () => {
  const tmpDir = makeTempDir("saved-configs-apikey-");
  const apiKeyStore = makeApiKeyStore(tmpDir);

  assert.equal(apiKeyStore.getProfileKey("profile-1"), null);

  apiKeyStore.saveProfileKey("profile-1", "sk_live_test_key");
  assert.equal(apiKeyStore.getProfileKey("profile-1"), "sk_live_test_key");

  apiKeyStore.deleteProfileKey("profile-1");
  assert.equal(apiKeyStore.getProfileKey("profile-1"), null);
});

test("ApiKeyStore persists DESKTOP_MANAGED provenance for current and profile keys", () => {
  const tmpDir = makeTempDir("saved-configs-apikey-source-");
  const apiKeyStore = makeApiKeyStore(tmpDir);

  apiKeyStore.setApiKey("sk_live_managed", "DESKTOP_MANAGED");
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_managed",
    provenance: "DESKTOP_MANAGED",
  });
  assert.equal(apiKeyStore.getStatus().provenance, "DESKTOP_MANAGED");

  const rehydrated = makeApiKeyStore(tmpDir);
  assert.deepEqual(rehydrated.getApiKeyRecord(), {
    apiKey: "sk_live_managed",
    provenance: "DESKTOP_MANAGED",
  });

  rehydrated.saveProfileKey(
    "profile-1",
    "sk_live_profile_managed",
    "DESKTOP_MANAGED"
  );
  assert.deepEqual(rehydrated.getProfileKeyRecord("profile-1"), {
    apiKey: "sk_live_profile_managed",
    provenance: "DESKTOP_MANAGED",
  });
});

test("ApiKeyStore treats legacy encrypted keys without provenance as USER_CREATED", () => {
  const tmpDir = makeTempDir("saved-configs-apikey-legacy-");
  fs.writeFileSync(
    path.join(tmpDir, "secrets.json"),
    JSON.stringify({
      encryptedApiKey: Buffer.from("stub:sk_live_legacy", "utf-8").toString(
        "base64"
      ),
    }),
    "utf-8"
  );

  const apiKeyStore = makeApiKeyStore(tmpDir);

  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_legacy",
    provenance: "USER_CREATED",
  });
});

test("ApiKeyStore treats environment keys as USER_CREATED", () => {
  const tmpDir = makeTempDir("saved-configs-apikey-env-");
  const previousClosedloopKey = process.env.CLOSEDLOOP_API_KEY;
  const previousSymphonyKey = process.env.SYMPHONY_API_KEY;
  process.env.CLOSEDLOOP_API_KEY = "sk_live_env";
  delete process.env.SYMPHONY_API_KEY;
  try {
    const apiKeyStore = makeApiKeyStore(tmpDir);

    assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
      apiKey: "sk_live_env",
      provenance: "USER_CREATED",
    });
  } finally {
    if (previousClosedloopKey === undefined) {
      delete process.env.CLOSEDLOOP_API_KEY;
    } else {
      process.env.CLOSEDLOOP_API_KEY = previousClosedloopKey;
    }
    if (previousSymphonyKey === undefined) {
      delete process.env.SYMPHONY_API_KEY;
    } else {
      process.env.SYMPHONY_API_KEY = previousSymphonyKey;
    }
  }
});

test("ApiKeyStore.deleteProfileKey is a no-op for unknown profileId", () => {
  const tmpDir = makeTempDir("saved-configs-apikey-noop-");
  const apiKeyStore = makeApiKeyStore(tmpDir);

  // Should not throw
  apiKeyStore.deleteProfileKey("nonexistent-id");
  assert.equal(apiKeyStore.getProfileKey("nonexistent-id"), null);
});

test("ApiKeyStore profile keys are isolated per profileId", () => {
  const tmpDir = makeTempDir("saved-configs-apikey-isolation-");
  const apiKeyStore = makeApiKeyStore(tmpDir);

  apiKeyStore.saveProfileKey("profile-A", "key-for-A");
  apiKeyStore.saveProfileKey("profile-B", "key-for-B");

  assert.equal(apiKeyStore.getProfileKey("profile-A"), "key-for-A");
  assert.equal(apiKeyStore.getProfileKey("profile-B"), "key-for-B");

  apiKeyStore.deleteProfileKey("profile-A");
  assert.equal(apiKeyStore.getProfileKey("profile-A"), null);
  assert.equal(apiKeyStore.getProfileKey("profile-B"), "key-for-B");
});

// --- profile config IPC registrar ---

test("profile config IPC registrar exposes the expected channels", () => {
  const tmpDir = makeTempDir("profile-ipc-channels-");
  const handlers = registerProfileHandlers(
    makeSettings(tmpDir),
    makeApiKeyStore(tmpDir)
  );

  assert.deepEqual(
    [...handlers.keys()].sort(),
    [...PROFILE_CONFIG_IPC_CHANNELS].sort()
  );
});

test("profile save IPC rejects invalid profile API keys before persisting", () => {
  const tmpDir = makeTempDir("profile-ipc-invalid-key-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const initialActiveKey = apiKeyStore.getApiKey();
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore);
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  assert.throws(
    () => saveConfig(null, { name: "Invalid", apiKey: "not-live" }),
    /API key must start with sk_live_/
  );
  assert.equal(settingsStore.listConfigs().length, 0);
  assert.equal(apiKeyStore.getApiKey(), initialActiveKey);
});

test("profile update IPC rejects invalid profile API keys before persisting", () => {
  const tmpDir = makeTempDir("profile-ipc-invalid-update-key-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  settingsStore.setRelayOrigin("https://relay.test");
  settingsStore.setApiOrigin("https://api.test");
  settingsStore.setWebAppOrigin("https://app.test");
  const config = settingsStore.saveConfig("Existing");
  settingsStore.applyConfig(config.id);
  const initialActiveKey = apiKeyStore.getApiKey();
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore);
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  assert.throws(
    () => saveConfig(null, { id: config.id, name: "Existing", apiKey: "bad" }),
    /API key must start with sk_live_/
  );
  assert.equal(apiKeyStore.getProfileKey(config.id), null);
  assert.equal(apiKeyStore.getApiKey(), initialActiveKey);
});

test("profile save IPC rejects unavailable encryption before creating a profile", () => {
  const tmpDir = makeTempDir("profile-ipc-unavailable-key-create-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const initialActiveKey = apiKeyStore.getApiKey();
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore, {
    encryptionAvailable: false,
  });
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  assert.throws(
    () =>
      saveConfig(null, {
        name: "Production",
        apiKey: "sk_live_profile_key",
      }),
    /safeStorage is not available/
  );
  assert.deepEqual(settingsStore.listConfigs(), []);
  assert.equal(settingsStore.getActiveConfigId(), null);
  assert.equal(apiKeyStore.getApiKey(), initialActiveKey);
});

test("profile update IPC rejects unavailable encryption before mutating profile", () => {
  const tmpDir = makeTempDir("profile-ipc-unavailable-key-update-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = settingsStore.saveConfig("Existing", {
    relayOrigin: "https://relay.original.test",
    apiOrigin: "https://api.original.test",
    webAppOrigin: "https://app.original.test",
  });
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore, {
    encryptionAvailable: false,
  });
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  assert.throws(
    () =>
      saveConfig(null, {
        id: config.id,
        name: "Renamed",
        relayOrigin: "https://relay.changed.test",
        apiKey: "sk_live_profile_key",
      }),
    /safeStorage is not available/
  );
  assert.deepEqual(settingsStore.listConfigs(), [config]);
  assert.equal(apiKeyStore.getProfileKey(config.id), null);
});

test("profile update IPC leaves inactive profile runtime fields unchanged", () => {
  const tmpDir = makeTempDir("profile-ipc-inactive-runtime-fields-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const active = settingsStore.saveConfig("Active", {
    relayOrigin: "https://relay.active.test",
    apiOrigin: "https://api.active.test",
    webAppOrigin: "https://app.active.test",
    gatewayPort: 1111,
    computeTarget: "active-target",
  });
  const inactive = settingsStore.saveConfig("Inactive", {
    relayOrigin: "https://relay.inactive.test",
    apiOrigin: "https://api.inactive.test",
    webAppOrigin: "https://app.inactive.test",
    gatewayPort: 2222,
    computeTarget: "inactive-target",
  });
  settingsStore.applyConfig(active.id);
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore, {
    gatewayPort: 9999,
    computeTarget: "runtime-active-target",
  });
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  const updated = saveConfig(null, {
    id: inactive.id,
    name: "Inactive renamed",
    relayOrigin: "https://relay.updated.test",
  }) as { computeTarget: string | null; gatewayPort: number | null };

  assert.equal(updated.gatewayPort, 2222);
  assert.equal(updated.computeTarget, "inactive-target");
  assert.deepEqual(
    settingsStore.listConfigs().find((config) => config.id === inactive.id),
    {
      ...inactive,
      name: "Inactive renamed",
      relayOrigin: "https://relay.updated.test",
    }
  );
});

test("profile update IPC keeps active profile runtime fields in sync", () => {
  const tmpDir = makeTempDir("profile-ipc-active-runtime-fields-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const active = settingsStore.saveConfig("Active", {
    relayOrigin: "https://relay.active.test",
    apiOrigin: "https://api.active.test",
    webAppOrigin: "https://app.active.test",
    gatewayPort: 1111,
    computeTarget: "active-target",
  });
  settingsStore.applyConfig(active.id);
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore, {
    gatewayPort: 9999,
    computeTarget: "runtime-active-target",
  });
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  const updated = saveConfig(null, {
    id: active.id,
    name: "Active renamed",
  }) as { computeTarget: string | null; gatewayPort: number | null };

  assert.equal(updated.gatewayPort, 9999);
  assert.equal(updated.computeTarget, "runtime-active-target");
  assert.equal(settingsStore.getActiveConfigId(), active.id);
});

test("profile save IPC cancels managed onboarding before activating explicit profile keys", () => {
  const tmpDir = makeTempDir("profile-ipc-explicit-key-cancel-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const cancelReasons: string[] = [];
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore, {
    cancelReasons,
  });
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  const saved = saveConfig(null, {
    name: "Manual",
    apiKey: "sk_live_manual_profile_key",
  }) as { id: string };

  assert.deepEqual(cancelReasons, [
    "a saved config with a manual API key was created",
  ]);
  assert.equal(settingsStore.getActiveConfigId(), saved.id);
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_manual_profile_key",
    provenance: "USER_CREATED",
  });
});

test("profile save IPC copies managed keys without activating the portable profile", () => {
  const tmpDir = makeTempDir("profile-ipc-managed-copy-");
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const restarts = { count: 0 };
  settingsStore.setRelayOrigin("https://relay.test");
  settingsStore.setApiOrigin("https://api.test");
  settingsStore.setWebAppOrigin("https://app.test");
  apiKeyStore.setApiKey("sk_live_managed", "DESKTOP_MANAGED");
  const handlers = registerProfileHandlers(settingsStore, apiKeyStore, {
    restarts,
  });
  const saveConfig = handlers.get(ProfileConfigIpcChannel.SaveConfig);
  assert.ok(saveConfig);

  const saved = saveConfig(null, { name: "Copied" }) as {
    id: string;
    apiKeySource?: string;
  };

  assert.equal(settingsStore.getActiveConfigId(), null);
  assert.deepEqual(apiKeyStore.getProfileKeyRecord(saved.id), {
    apiKey: "sk_live_managed",
    provenance: "USER_CREATED",
  });
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_managed",
    provenance: "DESKTOP_MANAGED",
  });
  assert.equal(saved.apiKeySource, "USER_CREATED");
  assert.equal(restarts.count, 0);
});
