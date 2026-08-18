/**
 * @file settings-ipc-collector-toggle.test.ts
 * @description FEA-3741 (slice 1) — the UpdateSettings IPC restarts collectors
 * ONLY when a per-tool collector toggle actually changes value, so a toggle
 * takes effect immediately (stop/resume that harness's watcher + tool-home walk)
 * without a relaunch — and unrelated settings updates never churn the
 * collectors.
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
  restarts: { count: number };
} {
  const tmpDir = makeTempDir("settings-ipc-collector-");
  const store = new SettingsStore({ cwd: tmpDir, name: "settings" });
  const apiKeyStore = new ApiKeyStore({
    cwd: tmpDir,
    name: "secrets",
    safeStorage: makeSafeStorage(),
  });
  const restarts = { count: 0 };
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
      setCloudCommandsPaused: () => {},
      getCloudConnectionEnabled: () => store.getCloudConnectionEnabled(),
      setCloudConnectionEnabled: () => {},
      sendFlagsChanged: () => {},
      restartCloudSocket: () => {},
      restartCollectors: () => {
        restarts.count += 1;
      },
    }
  );
  const handler = handlers.get(SettingsIpcChannel.UpdateSettings);
  if (!handler) {
    throw new Error("UpdateSettings handler must be registered");
  }
  return {
    update: (payload) => Promise.resolve(handler({}, payload)),
    store,
    restarts,
  };
}

test("FEA-3741: toggling a collector flag off restarts collectors and persists the value", async () => {
  const { update, store, restarts } = setup();
  await update({ collectCursorEnabled: false });
  assert.equal(
    restarts.count,
    1,
    "a collector toggle change restarts collectors"
  );
  assert.equal(
    store.getFlag("collectCursorEnabled"),
    false,
    "the new value is persisted"
  );
});

test("FEA-3741: re-writing the same collector value does NOT restart collectors", async () => {
  const { update, restarts } = setup();
  // Default is ON; writing ON again is a no-op change.
  await update({ collectClaudeEnabled: true });
  assert.equal(
    restarts.count,
    0,
    "an unchanged collector value must not churn the collectors"
  );
});

test("FEA-3741: an unrelated settings update does NOT restart collectors", async () => {
  const { update, restarts } = setup();
  await update({ verboseLogging: true });
  assert.equal(
    restarts.count,
    0,
    "non-collector settings updates leave collectors untouched"
  );
});

test("FEA-3741: each of the three collector toggles triggers a restart", async () => {
  for (const key of [
    "collectClaudeEnabled",
    "collectCursorEnabled",
    "collectCopilotEnabled",
  ] as const) {
    const { update, restarts } = setup();
    await update({ [key]: false });
    assert.equal(restarts.count, 1, `${key} off restarts collectors`);
  }
});
