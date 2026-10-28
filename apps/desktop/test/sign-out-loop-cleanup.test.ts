import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { GatewayIdentityStore } from "../src/main/auth/gateway-identity.js";
import { DesktopSessionStore } from "../src/main/session/desktop-session-store.js";
import { SignOutLoopCleanup } from "../src/main/session/sign-out-loop-cleanup.js";
import { ApiKeyStore } from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { mockSafeStorage } from "./helpers/desktop-session-manager-fixtures.js";

const CREDENTIAL_DELETION_FAILURE_RE = /credential deletion verification/;

let tempRoot = "";

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iss-10574-cleanup-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("cleanup preserves local preferences while deleting every persisted key and metadata copy", async () => {
  const settings = new SettingsStore({ cwd: tempRoot, name: "settings" });
  const keys = new ApiKeyStore({
    cwd: tempRoot,
    name: "secrets",
    safeStorage: mockSafeStorage(),
  });
  const sessionStore = new DesktopSessionStore({
    cwd: tempRoot,
    name: "desktop-session",
    safeStorage: mockSafeStorage(),
  });
  settings.setCloudConnectionEnabled(true);
  settings.setSavedConfigs([
    {
      id: "active-profile",
      name: "Active",
      relayOrigin: "https://relay.example.test",
      apiOrigin: "https://api.example.test",
      webAppOrigin: "https://app.example.test",
      sandboxBaseDirectory: path.join(tempRoot, "sandbox"),
      apiKeySource: "DESKTOP_MANAGED",
      gatewayId: "00000000-0000-4000-8000-000000000001",
      gatewayPublicKeyPem: "fixture",
      desktopSecurityUpgradeProtocolVersion: 1,
      lastComputeTargetId: "target-1",
      lastComputeTargetEnvironmentKey: "env-1",
      desktopSecurityPromptDismissedAt: "2026-09-21T00:00:00.000Z",
      pendingOnboardingAttemptId: "attempt-1",
    },
  ]);
  settings.setActiveConfigId("active-profile");
  keys.setApiKey("sk_live_active", "DESKTOP_MANAGED");
  keys.saveProfileKey("active-profile", "sk_live_profile", "DESKTOP_MANAGED");
  keys.saveProfileKey("orphan", "sk_live_orphan", "USER_CREATED");
  keys.saveProfileKey("legacy:colon", "sk_live_colon", "USER_CREATED");
  const cleanup = new SignOutLoopCleanup({
    settingsStore: settings,
    apiKeyStore: keys,
    desktopSessionStore: sessionStore,
    rotateLegacyGatewayIdentity: () => undefined,
    log: () => undefined,
  });

  await cleanup.run();

  assert.equal(settings.getSignOutCleanupState().isPending(), false);
  assert.equal(keys.hasPersistedApiKeyMaterial(), false);
  assert.equal(settings.hasAnyConfigManagedMetadata(), false);
  assert.equal(settings.getCloudConnectionEnabled(), true);
  assert.equal(settings.getActiveConfigId(), "active-profile");
  assert.equal(
    settings.getSavedConfigs()[0]?.sandboxBaseDirectory,
    path.join(tempRoot, "sandbox")
  );
});

test("session deletion failure keeps the marker while API keys are removed", async () => {
  const settings = new SettingsStore({ cwd: tempRoot, name: "settings" });
  const keys = new ApiKeyStore({
    cwd: tempRoot,
    name: "secrets",
    safeStorage: mockSafeStorage(),
  });
  keys.setApiKey("sk_live_active", "USER_CREATED");
  const cleanup = new SignOutLoopCleanup({
    settingsStore: settings,
    apiKeyStore: keys,
    desktopSessionStore: {
      clear: () => {
        throw new Error("fixture session-store failure");
      },
      hasSession: () => true,
    } as never,
    rotateLegacyGatewayIdentity: () => undefined,
    log: () => undefined,
  });

  await assert.rejects(cleanup.run(), CREDENTIAL_DELETION_FAILURE_RE);

  assert.equal(settings.getSignOutCleanupState().isPending(), true);
  assert.equal(keys.getApiKey(), null);
});

// ISS-12435: builds before the Loops removal journaled per-loop progress under
// `loops`. Nothing reads it now; cleanup must not stall on it and must drop it.
test("a loop journal left by an older build neither blocks cleanup nor survives it", async () => {
  const journalPath = path.join(tempRoot, "settings-sign-out-cleanup.json");
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      pending: true,
      loops: [
        {
          loopId: "",
          runtimeDetached: false,
          cloudCancelSettled: false,
          terminationSettled: false,
        },
      ],
    })
  );
  const settings = new SettingsStore({ cwd: tempRoot, name: "settings" });
  const keys = new ApiKeyStore({
    cwd: tempRoot,
    name: "secrets",
    safeStorage: mockSafeStorage(),
  });
  keys.setApiKey("sk_live_active", "USER_CREATED");
  const cleanup = new SignOutLoopCleanup({
    settingsStore: settings,
    apiKeyStore: keys,
    desktopSessionStore: new DesktopSessionStore({
      cwd: tempRoot,
      name: "desktop-session",
      safeStorage: mockSafeStorage(),
    }),
    rotateLegacyGatewayIdentity: () => undefined,
    log: () => undefined,
  });

  await cleanup.resumeIfPending();

  assert.equal(settings.getSignOutCleanupState().isPending(), false);
  assert.equal(keys.getApiKey(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(journalPath, "utf8")), {});
});

test("sign-out durably suppresses both environment-key fallbacks", async () => {
  const previousClosedloop = process.env.CLOSEDLOOP_API_KEY;
  const previousSymphony = process.env.SYMPHONY_API_KEY;
  try {
    process.env.CLOSEDLOOP_API_KEY = "sk_live_environment_closedloop";
    process.env.SYMPHONY_API_KEY = "sk_live_environment_symphony";
    const settings = new SettingsStore({ cwd: tempRoot, name: "settings" });
    const keys = new ApiKeyStore({
      cwd: tempRoot,
      name: "secrets",
      safeStorage: mockSafeStorage(),
    });
    const cleanup = new SignOutLoopCleanup({
      settingsStore: settings,
      apiKeyStore: keys,
      desktopSessionStore: new DesktopSessionStore({
        cwd: tempRoot,
        name: "desktop-session",
        safeStorage: mockSafeStorage(),
      }),
      rotateLegacyGatewayIdentity: () => undefined,
      log: () => undefined,
    });

    assert.equal(keys.getStatus().source, "environment");
    await cleanup.run();

    const reloaded = new ApiKeyStore({
      cwd: tempRoot,
      name: "secrets",
      safeStorage: mockSafeStorage(),
    });
    assert.equal(reloaded.getApiKey(), null);
    reloaded.setApiKey("sk_live_fresh", "USER_CREATED");
    assert.equal(reloaded.getApiKey(), "sk_live_fresh");
  } finally {
    restoreEnv("CLOSEDLOOP_API_KEY", previousClosedloop);
    restoreEnv("SYMPHONY_API_KEY", previousSymphony);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

// ISS-11843 (operator ruling, Marisol Ashgrove 2026-10-05): an account change gets
// a new gateway identity. Saved profiles lose theirs to the metadata clear; an
// install with no saved profile declares the unsaved identity, which sign-out
// must replace or the next account's hello collides with the last one's target.
test("sign-out replaces the unsaved-profile gateway identity", async () => {
  const settings = new SettingsStore({ cwd: tempRoot, name: "settings" });
  const keys = new ApiKeyStore({
    cwd: tempRoot,
    name: "secrets",
    safeStorage: mockSafeStorage(),
  });
  const identity = new GatewayIdentityStore(tempRoot);
  const before = identity.loadSync();
  const cleanup = new SignOutLoopCleanup({
    settingsStore: settings,
    apiKeyStore: keys,
    desktopSessionStore: new DesktopSessionStore({
      cwd: tempRoot,
      name: "desktop-session",
      safeStorage: mockSafeStorage(),
    }),
    rotateLegacyGatewayIdentity: () => identity.rotateSync(),
    log: () => undefined,
  });

  await cleanup.run();

  const after = identity.currentSync();
  assert.notEqual(after, before);
  assert.equal(new GatewayIdentityStore(tempRoot).loadSync(), after);
});
