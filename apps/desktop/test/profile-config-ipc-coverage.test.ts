/**
 * @file profile-config-ipc-coverage.test.ts
 * @description ISS-10514: behavior pins for the profile-config IPC branch
 * arms the neighbouring suites (ipc-profile-channels, saved-configs,
 * profile-sandbox) do not reach: the non-string apiKey format guard (plus its
 * whitespace-trimming twin), the missing-payload fallback,
 * updating/activating an EXISTING active profile with an explicit key (and
 * leaving its active key alone without one), copying a plain USER_CREATED
 * active key onto a new profile versus copying a DESKTOP_MANAGED one (which
 * mints its own gateway identity and never activates), the id/name
 * validation guards on DeleteConfig/RenameConfig/ApplyConfig -- including the
 * truthy-non-string-id cases that fall through to the store's own "not
 * found" error -- a successful RenameConfig, the active-config-deleted hook
 * firing only for the active profile, and ApplyConfig's hasManagedIdentity
 * gate across its three operands. The gate cases pin the persisted profile
 * row and the active key record; ApplyConfig's reply is a pre-recompute
 * snapshot and is pinned as such in the last case only.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeClosedloopApiKey,
  ProfileConfigIpcChannel,
  registerProfileConfigIpcHandlers,
} from "../src/main/ipc/profile-config-ipc.js";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import type { ApiKeyProvenance, SavedConfig } from "../src/shared/contracts.js";
import {
  createIpcRegistrar,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
} from "./helpers/ipc-registrar.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const API_KEY_FORMAT_RE = /API key must start with sk_live_/;
const NAME_REQUIRED_RE = /name is required/i;
const ID_REQUIRED_RE = /id is required/;
const APPLY_ENCRYPTION_UNAVAILABLE_RE =
  /safeStorage is not available -- cannot apply config/;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const { makeTempDir } = createTempDirManager("profile-config-ipc-coverage-");

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

function makeSettings(tmpDir: string): SettingsStore {
  return new SettingsStore({ cwd: tmpDir, name: "settings" });
}

function makeApiKeyStore(tmpDir: string): ApiKeyStore {
  return new ApiKeyStore({
    cwd: tmpDir,
    name: "secrets",
    safeStorage: makeTestSafeStorage(),
  });
}

type RegisterOverrides = {
  encryptionAvailable?: boolean;
  activeDeleted?: { count: number };
};

function registerHandlers(
  settingsStore: SettingsStore,
  apiKeyStore: ApiKeyStore,
  overrides: RegisterOverrides = {}
) {
  const harness = createIpcRegistrar();
  registerProfileConfigIpcHandlers(harness.registrar, {
    isTrustedSender: isTrustedSenderDouble,
    settingsStore,
    apiKeyStore,
    getGatewaySnapshot: () => ({ gatewayPort: null, computeTarget: null }),
    cancelManagedOnboardingForUserChange: () => {},
    onActiveConfigDeleted: () => {
      if (overrides.activeDeleted) {
        overrides.activeDeleted.count += 1;
      }
    },
    onConfigDeleted: () => {},
    restartCloudSocket: () => {},
    isEncryptionAvailable: () => overrides.encryptionAvailable ?? true,
    seedReposConfig: () => Promise.resolve(),
  });
  return harness;
}

/** Saves a profile and gives it a profile-scoped key with the given provenance. */
function saveConfigWithProfileKey(
  settingsStore: SettingsStore,
  apiKeyStore: ApiKeyStore,
  name: string,
  keyProvenance: ApiKeyProvenance
): SavedConfig {
  const config = settingsStore.saveConfig(name);
  apiKeyStore.saveProfileKey(
    config.id,
    `sk_live_${name.toLowerCase()}`,
    keyProvenance
  );
  return config;
}

// --- normalizeClosedloopApiKey ---

test("normalizeClosedloopApiKey rejects a non-string value instead of coercing it", () => {
  assert.throws(() => normalizeClosedloopApiKey(42), API_KEY_FORMAT_RE);
  assert.throws(() => normalizeClosedloopApiKey(undefined), API_KEY_FORMAT_RE);
  assert.throws(() => normalizeClosedloopApiKey(null), API_KEY_FORMAT_RE);
});

test("normalizeClosedloopApiKey trims surrounding whitespace before validating the prefix", () => {
  assert.equal(
    normalizeClosedloopApiKey("  sk_live_padded_key  "),
    "sk_live_padded_key"
  );
});

// --- saveConfig: missing payload / missing name ---

test("saveConfig IPC treats a missing payload as empty fields and rejects the resulting blank name", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const harness = registerHandlers(settingsStore, apiKeyStore);

  assert.throws(
    () =>
      harness.invoke(
        ProfileConfigIpcChannel.SaveConfig,
        TRUSTED_EVENT,
        undefined
      ),
    NAME_REQUIRED_RE
  );
  assert.deepEqual(settingsStore.listConfigs(), []);
});

// --- saveConfig: updating the active profile with an explicit key ---

test("saveConfig IPC persists and activates an explicit key when updating the active profile", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const active = settingsStore.saveConfig("Active");
  settingsStore.applyConfig(active.id);
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const updated = harness.invoke(
    ProfileConfigIpcChannel.SaveConfig,
    TRUSTED_EVENT,
    { id: active.id, name: "Active", apiKey: "sk_live_active_explicit" }
  ) as SavedConfig;

  assert.equal(updated.apiKeySource, "USER_CREATED");
  assert.deepEqual(apiKeyStore.getProfileKeyRecord(active.id), {
    apiKey: "sk_live_active_explicit",
    provenance: "USER_CREATED",
  });
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_active_explicit",
    provenance: "USER_CREATED",
  });
});

test("saveConfig IPC leaves the active api key untouched when updating the active profile without an explicit key", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const active = settingsStore.saveConfig("Active");
  settingsStore.applyConfig(active.id);
  apiKeyStore.setApiKey("sk_live_preexisting", "USER_CREATED");
  const harness = registerHandlers(settingsStore, apiKeyStore);

  harness.invoke(ProfileConfigIpcChannel.SaveConfig, TRUSTED_EVENT, {
    id: active.id,
    name: "Active Renamed",
  });

  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_preexisting",
    provenance: "USER_CREATED",
  });
});

// --- saveConfig: copying a plain USER_CREATED active key onto a new profile ---

test("saveConfig IPC copies a user-created active key onto a new profile and activates it", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  apiKeyStore.setApiKey("sk_live_user_created", "USER_CREATED");
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const saved = harness.invoke(
    ProfileConfigIpcChannel.SaveConfig,
    TRUSTED_EVENT,
    { name: "Copied" }
  ) as SavedConfig;

  assert.equal(settingsStore.getActiveConfigId(), saved.id);
  assert.equal(saved.apiKeySource, "USER_CREATED");
  assert.equal(
    "gatewayId" in saved,
    false,
    "a non-DESKTOP_MANAGED copy must not fabricate a gateway identity"
  );
  assert.deepEqual(apiKeyStore.getProfileKeyRecord(saved.id), {
    apiKey: "sk_live_user_created",
    provenance: "USER_CREATED",
  });
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_user_created",
    provenance: "USER_CREATED",
  });
});

test("saveConfig IPC gives a copied DESKTOP_MANAGED key its own gateway identity and does not activate the new profile", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  apiKeyStore.setApiKey("sk_live_managed_source", "DESKTOP_MANAGED");
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const saved = harness.invoke(
    ProfileConfigIpcChannel.SaveConfig,
    TRUSTED_EVENT,
    { name: "Managed Copy" }
  ) as SavedConfig;

  assert.equal(
    settingsStore.getActiveConfigId(),
    null,
    "a DESKTOP_MANAGED copy must not activate the new profile"
  );
  assert.equal(saved.apiKeySource, "USER_CREATED");
  assert.match(saved.gatewayId ?? "", UUID_V4_RE);
  assert.equal(saved.desktopSecurityUpgradeProtocolVersion, 1);
  assert.deepEqual(apiKeyStore.getProfileKeyRecord(saved.id), {
    apiKey: "sk_live_managed_source",
    provenance: "USER_CREATED",
  });
  // The active key is untouched -- a DESKTOP_MANAGED copy never activates.
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_managed_source",
    provenance: "DESKTOP_MANAGED",
  });
});

// --- deleteConfig ---

test("deleteConfig IPC rejects a payload without a string id", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const harness = registerHandlers(settingsStore, apiKeyStore);

  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.DeleteConfig, TRUSTED_EVENT, {}),
    ID_REQUIRED_RE
  );
  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.DeleteConfig, TRUSTED_EVENT, {
        id: 42,
      }),
    ID_REQUIRED_RE
  );
});

test("deleteConfig IPC notifies the active-config-deleted hook when the deleted profile was active", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = settingsStore.saveConfig("Active");
  settingsStore.applyConfig(config.id);
  const activeDeleted = { count: 0 };
  const harness = registerHandlers(settingsStore, apiKeyStore, {
    activeDeleted,
  });

  const result = harness.invoke(
    ProfileConfigIpcChannel.DeleteConfig,
    TRUSTED_EVENT,
    { id: config.id }
  ) as { wasActive: boolean };

  assert.equal(result.wasActive, true);
  assert.equal(activeDeleted.count, 1);
});

test("deleteConfig IPC does not notify the active-config-deleted hook for a non-active profile", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = settingsStore.saveConfig("Inactive");
  const activeDeleted = { count: 0 };
  const harness = registerHandlers(settingsStore, apiKeyStore, {
    activeDeleted,
  });

  const result = harness.invoke(
    ProfileConfigIpcChannel.DeleteConfig,
    TRUSTED_EVENT,
    { id: config.id }
  ) as { wasActive: boolean };

  assert.equal(result.wasActive, false);
  assert.equal(activeDeleted.count, 0);
});

// --- renameConfig ---

test("renameConfig IPC rejects a payload without a string id", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const harness = registerHandlers(settingsStore, apiKeyStore);

  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.RenameConfig, TRUSTED_EVENT, {}),
    ID_REQUIRED_RE
  );
  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.RenameConfig, TRUSTED_EVENT, {
        id: 42,
        name: "Renamed",
      }),
    ID_REQUIRED_RE
  );
});

test("renameConfig IPC persists a valid name and returns no value", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = settingsStore.saveConfig("Original");
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const result = harness.invoke(
    ProfileConfigIpcChannel.RenameConfig,
    TRUSTED_EVENT,
    { id: config.id, name: "Renamed" }
  );

  assert.equal(result, undefined);
  assert.equal(settingsStore.listConfigs()[0]?.name, "Renamed");
});

test("renameConfig IPC treats a non-string name as blank and rejects it", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = settingsStore.saveConfig("Original");
  const harness = registerHandlers(settingsStore, apiKeyStore);

  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.RenameConfig, TRUSTED_EVENT, {
        id: config.id,
        name: 42,
      }),
    NAME_REQUIRED_RE
  );
  assert.equal(settingsStore.listConfigs()[0]?.name, "Original");
});

// --- applyConfig: id / encryption guards ---

test("applyConfig IPC rejects a payload without a string id", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const harness = registerHandlers(settingsStore, apiKeyStore);

  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.ApplyConfig, TRUSTED_EVENT, {}),
    ID_REQUIRED_RE
  );
  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.ApplyConfig, TRUSTED_EVENT, {
        id: 42,
      }),
    ID_REQUIRED_RE
  );
});

test("applyConfig IPC rejects when encryption is unavailable", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = settingsStore.saveConfig("Locked");
  const harness = registerHandlers(settingsStore, apiKeyStore, {
    encryptionAvailable: false,
  });

  assert.throws(
    () =>
      harness.invoke(ProfileConfigIpcChannel.ApplyConfig, TRUSTED_EVENT, {
        id: config.id,
      }),
    APPLY_ENCRYPTION_UNAVAILABLE_RE
  );
  assert.equal(settingsStore.getActiveConfigId(), null);
});

// --- applyConfig: hasManagedIdentity gate (gatewayId && gatewayPublicKeyPem && DESKTOP_MANAGED key) ---

test("applyConfig IPC marks a profile key USER_CREATED when the profile has no gateway identity", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  // The profile key itself is DESKTOP_MANAGED; only the missing gatewayId
  // should force USER_CREATED here.
  const config = saveConfigWithProfileKey(
    settingsStore,
    apiKeyStore,
    "NoGateway",
    "DESKTOP_MANAGED"
  );
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const applied = harness.invoke(
    ProfileConfigIpcChannel.ApplyConfig,
    TRUSTED_EVENT,
    { id: config.id }
  ) as SavedConfig;

  assert.equal(applied.apiKeySource, "USER_CREATED");
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_nogateway",
    provenance: "USER_CREATED",
  });
});

test("applyConfig IPC marks a profile key USER_CREATED when the gateway identity has no public key", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = saveConfigWithProfileKey(
    settingsStore,
    apiKeyStore,
    "PartialGateway",
    "DESKTOP_MANAGED"
  );
  const withGatewayId = settingsStore.updateConfigManagedMetadata(config.id, {
    gatewayId: "22222222-2222-4222-8222-222222222222",
  });
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const applied = harness.invoke(
    ProfileConfigIpcChannel.ApplyConfig,
    TRUSTED_EVENT,
    { id: withGatewayId.id }
  ) as SavedConfig;

  // The reply is the pre-recompute snapshot (see the last test), so the pin is
  // on the persisted row and the active key, which the gate actually rewrites.
  assert.equal(applied.id, withGatewayId.id);
  assert.equal(
    settingsStore.listConfigs().find((c) => c.id === withGatewayId.id)
      ?.apiKeySource,
    "USER_CREATED"
  );
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_partialgateway",
    provenance: "USER_CREATED",
  });
});

test("applyConfig IPC marks a profile key USER_CREATED when the key itself is not desktop-managed", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  // Full gateway identity present, but the profile key's own provenance is
  // USER_CREATED -- hasManagedIdentity must still evaluate false.
  const config = saveConfigWithProfileKey(
    settingsStore,
    apiKeyStore,
    "FullIdentity",
    "USER_CREATED"
  );
  const withIdentity = settingsStore.updateConfigManagedMetadata(config.id, {
    gatewayId: "33333333-3333-4333-8333-333333333333",
    gatewayPublicKeyPem:
      "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
  });
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const applied = harness.invoke(
    ProfileConfigIpcChannel.ApplyConfig,
    TRUSTED_EVENT,
    { id: withIdentity.id }
  ) as SavedConfig;

  // Same stale-snapshot caveat as above: pin the persisted row and active key.
  assert.equal(applied.id, withIdentity.id);
  assert.equal(
    settingsStore.listConfigs().find((c) => c.id === withIdentity.id)
      ?.apiKeySource,
    "USER_CREATED"
  );
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_fullidentity",
    provenance: "USER_CREATED",
  });
});

test("applyConfig IPC preserves DESKTOP_MANAGED when the profile has a full gateway identity and a managed key", () => {
  const tmpDir = makeTempDir();
  const settingsStore = makeSettings(tmpDir);
  const apiKeyStore = makeApiKeyStore(tmpDir);
  const config = saveConfigWithProfileKey(
    settingsStore,
    apiKeyStore,
    "ManagedIdentity",
    "DESKTOP_MANAGED"
  );
  const withIdentity = settingsStore.updateConfigManagedMetadata(config.id, {
    gatewayId: "44444444-4444-4444-8444-444444444444",
    gatewayPublicKeyPem:
      "-----BEGIN PUBLIC KEY-----\nxyz\n-----END PUBLIC KEY-----",
  });
  const harness = registerHandlers(settingsStore, apiKeyStore);

  const applied = harness.invoke(
    ProfileConfigIpcChannel.ApplyConfig,
    TRUSTED_EVENT,
    { id: withIdentity.id }
  ) as SavedConfig;

  // pins current behavior; looks odd because the handler snapshots
  // `appliedConfig` from `settingsStore.applyConfig(id)` BEFORE it recomputes
  // and persists `apiKeySource`, then returns that stale snapshot -- so the
  // IPC reply still reports the pre-update "USER_CREATED" even though the
  // store row and the active api key are both updated to DESKTOP_MANAGED.
  assert.equal(applied.apiKeySource, "USER_CREATED");
  assert.equal(
    settingsStore.listConfigs().find((c) => c.id === withIdentity.id)
      ?.apiKeySource,
    "DESKTOP_MANAGED"
  );
  assert.deepEqual(apiKeyStore.getApiKeyRecord(), {
    apiKey: "sk_live_managedidentity",
    provenance: "DESKTOP_MANAGED",
  });
});
