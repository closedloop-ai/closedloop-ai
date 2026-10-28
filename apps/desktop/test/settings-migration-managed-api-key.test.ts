/**
 * @file settings-migration-managed-api-key.test.ts
 * @description ISS-5703 — the boot-time managed `apiKeySource` reconciliation,
 * driven through the production path (`new SettingsStore(...)` →
 * `runSettingsMigrations` → `migrateSavedConfigManagedFields`).
 *
 * That migration used to carry its own copy of the managed-identity predicate
 * while `reconcileManagedApiKeySources` (`settings/saved-config.ts`) implemented
 * the identical rule with no caller. The duplicate body was collapsed onto the
 * helper, which is now the ONE owner of the rule. These cases pin the
 * retention/demotion matrix that collapse must preserve — a profile keeps
 * `DESKTOP_MANAGED` only with BOTH a v4 gateway UUID and a public-key PEM, and
 * otherwise falls back to `USER_CREATED`.
 *
 * Scope note: these assertions pin the reconciled OUTCOME per profile. They do
 * not observe the helper's `changed` flag, so they do not pin the skip-the-write
 * no-op path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { SettingsStore } from "../src/main/settings/settings-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_GATEWAY_UUID = "b3d1f0a2-5c7e-4f2b-9a1d-6e8c0f4a7b21";
/** Same shape, version nibble 1 — a UUID, but not the v4 the contract requires. */
const NON_V4_GATEWAY_UUID = "b3d1f0a2-5c7e-1f2b-9a1d-6e8c0f4a7b21";
const PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n";

function baseConfig(id: string, name: string) {
  return {
    id,
    name,
    relayOrigin: "https://relay.closedloop.ai",
    apiOrigin: "https://api.closedloop.ai",
    webAppOrigin: "https://app.closedloop.ai",
  };
}

function seedStore(
  storeName: string,
  savedConfigs: Record<string, unknown>[]
): SettingsStore {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-managed-api-key-")
  );
  tempDirs.push(tmpDir);
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({ savedConfigs })
  );
  return new SettingsStore({ cwd: tmpDir, name: storeName });
}

test("ISS-5703: a managed profile carrying a v4 gateway UUID and a public-key PEM keeps DESKTOP_MANAGED", () => {
  const store = seedStore("managed-complete-identity", [
    {
      ...baseConfig("cfg-complete", "Complete"),
      apiKeySource: "DESKTOP_MANAGED",
      gatewayId: VALID_GATEWAY_UUID,
      gatewayPublicKeyPem: PUBLIC_KEY_PEM,
    },
  ]);

  const [config] = store.getSavedConfigs();
  assert.equal(config?.apiKeySource, "DESKTOP_MANAGED");
});

test("ISS-5703: a managed profile with no public-key PEM is demoted to USER_CREATED", () => {
  const store = seedStore("managed-missing-pem", [
    {
      ...baseConfig("cfg-no-pem", "No PEM"),
      apiKeySource: "DESKTOP_MANAGED",
      gatewayId: VALID_GATEWAY_UUID,
    },
  ]);

  const [config] = store.getSavedConfigs();
  assert.equal(
    config?.apiKeySource,
    "USER_CREATED",
    "a profile cannot claim DESKTOP_MANAGED provenance without the public key that proves it"
  );
});

test("ISS-5703: a managed profile whose gateway id is not a v4 UUID is demoted to USER_CREATED", () => {
  const store = seedStore("managed-non-v4-uuid", [
    {
      ...baseConfig("cfg-non-v4", "Non v4"),
      apiKeySource: "DESKTOP_MANAGED",
      gatewayId: NON_V4_GATEWAY_UUID,
      gatewayPublicKeyPem: PUBLIC_KEY_PEM,
    },
  ]);

  const [config] = store.getSavedConfigs();
  assert.equal(config?.apiKeySource, "USER_CREATED");
});

test("ISS-5703: reconciliation is per-profile — a complete profile survives alongside a demoted one", () => {
  const store = seedStore("managed-mixed-list", [
    {
      ...baseConfig("cfg-keeps", "Keeps"),
      apiKeySource: "DESKTOP_MANAGED",
      gatewayId: VALID_GATEWAY_UUID,
      gatewayPublicKeyPem: PUBLIC_KEY_PEM,
    },
    {
      ...baseConfig("cfg-demoted", "Demoted"),
      apiKeySource: "DESKTOP_MANAGED",
    },
    {
      ...baseConfig("cfg-user", "User"),
      apiKeySource: "USER_CREATED",
      gatewayId: VALID_GATEWAY_UUID,
      gatewayPublicKeyPem: PUBLIC_KEY_PEM,
    },
  ]);

  assert.deepEqual(
    store.getSavedConfigs().map((config) => config.apiKeySource),
    ["DESKTOP_MANAGED", "USER_CREATED", "USER_CREATED"],
    "one profile failing the identity check must not rewrite its neighbours"
  );
});
