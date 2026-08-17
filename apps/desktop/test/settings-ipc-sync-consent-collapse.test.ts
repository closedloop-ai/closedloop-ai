/**
 * @file settings-ipc-sync-consent-collapse.test.ts
 * @description FEA-4103 — the generic `desktop:update-settings` IPC must NOT be
 * able to set the consent-tier sub-flags (`transcriptSyncEnabled`,
 * `syncObservabilityTier`) independently. Those are DERIVED from the one
 * canonical `DataSyncLevel`; letting a renderer write them here would desync the
 * level the "Data & Sync" UI shows from the actually-enforced egress (a lying
 * UI). The ONLY sanctioned writer is `setDataSyncLevel`. The orthogonal
 * operational connectivity flags (`cloudConnectionEnabled`, `cloudCommandsPaused`)
 * remain settable through this path — they are live Relay/Gateway controls, and
 * the level is reconciled against them on read.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  registerSettingsIpcHandlers,
  SettingsIpcChannel,
} from "../src/main/ipc/settings-ipc.js";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { DataSyncLevel } from "../src/shared/contracts.js";
import { DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY } from "../src/shared/feature-flags.js";

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

function makeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) =>
      Buffer.from(`stub:${plainText}`, "utf-8"),
    decryptString: (encrypted: Buffer) => {
      const s = encrypted.toString("utf-8");
      return s.startsWith("stub:") ? s.slice(5) : s;
    },
  };
}

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

function setup(): {
  update: (payload: Record<string, unknown>) => Promise<unknown>;
  store: SettingsStore;
} {
  const tmpDir = makeTempDir("settings-ipc-consent-");
  const store = new SettingsStore({ cwd: tmpDir, name: "settings" });
  const apiKeyStore = new ApiKeyStore({
    cwd: tmpDir,
    name: "secrets",
    safeStorage: makeSafeStorage(),
  });
  const handlers = new Map<string, IpcHandler>();
  registerSettingsIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as IpcHandler);
      },
    },
    {
      isTrustedSender: () => true,
      settingsStore: store,
      apiKeyStore,
      pruneAlwaysAllowRules: (rules) => rules ?? [],
      isGoldenMode: () => false,
      cancelManagedOnboardingForUserChange: () => {},
      getCloudCommandsPaused: () => store.getCloudCommandsPaused(),
      setCloudCommandsPaused: (paused) => store.setCloudCommandsPaused(paused),
      getCloudConnectionEnabled: () => store.getCloudConnectionEnabled(),
      setCloudConnectionEnabled: (enabled) =>
        store.setCloudConnectionEnabled(enabled),
      sendFlagsChanged: () => {},
      restartCloudSocket: () => {},
      restartCollectors: () => {},
    }
  );
  const handler = handlers.get(SettingsIpcChannel.UpdateSettings);
  if (!handler) {
    throw new Error("UpdateSettings handler must be registered");
  }
  return {
    update: (payload) => Promise.resolve(handler({}, payload)),
    store,
  };
}

test("FEA-4103: updateSettings cannot independently enable transcript sync", async () => {
  const { update, store } = setup();
  // Canonical default level is Metadata → transcript lane OFF.
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Metadata);
  assert.equal(store.getTranscriptSyncEnabled(), false);

  // A renderer trying to flip the derived sub-flag on directly must be ignored.
  await update({ [DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY]: true });

  assert.equal(
    store.getTranscriptSyncEnabled(),
    false,
    "the derived transcript-sync flag must NOT be settable through the generic path"
  );
  assert.equal(
    store.getDataSyncLevel(),
    DataSyncLevel.Metadata,
    "the canonical level is unchanged — no divergence between UI and enforced egress"
  );
});

test("FEA-4103: updateSettings cannot independently set the observability tier", async () => {
  const { update, store } = setup();
  // Unset by default: no tier is persisted until a level pick derives one.
  assert.equal(store.getSyncObservabilityTier(), null);

  await update({ syncObservabilityTier: "full" });

  assert.equal(
    store.getSyncObservabilityTier(),
    // The injected "full" is stripped, so the field is left untouched (still
    // unset) — the generic path cannot set the tier out from under the level.
    null,
    "the derived observability tier must NOT be settable through the generic path"
  );
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Metadata);
});

test("FEA-4103: setDataSyncLevel remains the single writer that flips the derived flags", () => {
  const { store } = setup();
  store.setDataSyncLevel(DataSyncLevel.Full);
  assert.equal(
    store.getTranscriptSyncEnabled(),
    true,
    "the canonical setter derives the transcript lane on for Full"
  );
  assert.equal(store.getSyncObservabilityTier(), "full");
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Full);
});

test("FEA-4103: orthogonal connectivity/pause flags stay settable through updateSettings", async () => {
  const { update, store } = setup();
  // Start from the connected default (Metadata → connection on, not paused).
  assert.equal(store.getCloudConnectionEnabled(), true);
  assert.equal(store.getCloudCommandsPaused(), false);

  await update({ cloudConnectionEnabled: false, cloudCommandsPaused: true });

  // The orthogonal Relay/Gateway controls are NOT stripped — they persist.
  assert.equal(
    store.getCloudConnectionEnabled(),
    false,
    "the Relay/Gateway connection control still applies through the generic path"
  );
  assert.equal(
    store.getCloudCommandsPaused(),
    true,
    "the Relay/Gateway pause control still applies through the generic path"
  );
});

test("FEA-4103: mixed payload strips only the consent sub-flags, keeps the rest", async () => {
  const { update, store } = setup();
  await update({
    [DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY]: true,
    syncObservabilityTier: "full",
    verboseLogging: true,
  });
  assert.equal(
    store.getTranscriptSyncEnabled(),
    false,
    "transcript-sync stripped"
  );
  assert.equal(
    store.getSyncObservabilityTier(),
    null,
    "observability tier stripped (left unset, not the injected value)"
  );
  assert.equal(
    store.getFlag("verboseLogging"),
    true,
    "unrelated flags in the same payload still apply"
  );
});
