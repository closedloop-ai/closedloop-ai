// ISS-10514: branch coverage for the `desktop:update-settings` IPC handler,
// driven through the real `registerSettingsIpcHandlers` registration against the
// shared registrar double and a real temp-dir `SettingsStore`. Covers the
// trusted-sender gate, the binaryPaths refusal, golden-mode lockout, legacy
// "auto" tier folding, origin normalization, the onboarding sandbox guard, the
// manual-change cancel hook, cloud pause/connection side effects, and repo
// seeding on a new sandbox.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test, vi } from "vitest";
import { registerSettingsIpcHandlers } from "../src/main/ipc/settings-ipc.js";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import type { DesktopSettings } from "../src/shared/contracts.js";
import { SettingsIpcChannel } from "../src/shared/settings-ipc-channel.js";
import {
  createIpcRegistrar,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const BINARY_PATHS_ERROR = /binaryPaths must be updated via PATCH/;
const ONBOARDING_SANDBOX_ERROR =
  /Complete onboarding requires a sandbox base directory/;
const INVALID_ORIGIN_ERROR = /Origin must use https/;
const MANUAL_CHANGE_REASON = "settings were updated manually";

// Which of the two a case wants is decided by whether the handler VALIDATES
// the sandbox it is handed: a payload sandbox goes through
// `validateSandboxBaseDirectory`, which rejects `os.tmpdir()`'s
// `/private/var/...` realpath on macOS, so those cases need
// `makeSandboxRootTempDir`. A sandbox the case only pre-stores or reads back
// never reaches that guard, so `fs.realpathSync(makeTempDir(...))` is correct
// there and stays on the system temp dir.
const { makeSandboxRootTempDir, makeTempDir } = createTempDirManager(
  "settings-ipc-coverage-"
);

type Harness = {
  update: (
    payload: Record<string, unknown>,
    event?: unknown
  ) => Promise<unknown>;
  store: SettingsStore;
  calls: {
    cancelReasons: string[];
    setCloudCommandsPaused: boolean[];
    setCloudConnectionEnabled: boolean[];
    flagsChanged: number;
    socketRestarts: number;
  };
};

function makeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) =>
      Buffer.from(`stub:${plainText}`, "utf-8"),
    decryptString: (encrypted: Buffer) =>
      encrypted.toString("utf-8").replace("stub:", ""),
  };
}

function setup(options: { goldenMode?: boolean } = {}): Harness {
  const dir = makeTempDir();
  const store = new SettingsStore({ cwd: dir, name: "settings" });
  const apiKeyStore = new ApiKeyStore({
    cwd: dir,
    name: "secrets",
    safeStorage: makeSafeStorage(),
  });
  const calls: Harness["calls"] = {
    cancelReasons: [],
    setCloudCommandsPaused: [],
    setCloudConnectionEnabled: [],
    flagsChanged: 0,
    socketRestarts: 0,
  };
  // The live runtime state the app holds in memory; the handler compares the
  // persisted value against it AFTER the store write, so it must not read the store.
  const runtime = { commandsPaused: false, connectionEnabled: true };
  const ipc = createIpcRegistrar();
  registerSettingsIpcHandlers(ipc.registrar, {
    isTrustedSender: isTrustedSenderDouble,
    settingsStore: store,
    apiKeyStore,
    pruneAlwaysAllowRules: (rules) => rules ?? [],
    isGoldenMode: () => options.goldenMode === true,
    cancelManagedOnboardingForUserChange: (reason) => {
      calls.cancelReasons.push(reason);
    },
    getCloudCommandsPaused: () => runtime.commandsPaused,
    setCloudCommandsPaused: (paused) => {
      runtime.commandsPaused = paused;
      calls.setCloudCommandsPaused.push(paused);
    },
    getCloudConnectionEnabled: () => runtime.connectionEnabled,
    setCloudConnectionEnabled: (enabled) => {
      runtime.connectionEnabled = enabled;
      calls.setCloudConnectionEnabled.push(enabled);
    },
    sendFlagsChanged: () => {
      calls.flagsChanged += 1;
    },
    restartCloudSocket: () => {
      calls.socketRestarts += 1;
    },
    restartCollectors: () => {},
  });
  return {
    update: (payload, event = TRUSTED_EVENT) =>
      Promise.resolve(
        ipc.invoke(SettingsIpcChannel.UpdateSettings, event, payload)
      ),
    store,
    calls,
  };
}

describe("desktop:update-settings rejections", () => {
  test("an untrusted sender is refused before anything is persisted", async () => {
    const { update, store, calls } = setup();

    await assert.rejects(
      update({ defaultApprovalTier: "low" }, UNTRUSTED_EVENT),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(store.getAll().defaultApprovalTier, "high");
    assert.equal(calls.flagsChanged, 0);
  });

  test("a payload carrying binaryPaths is refused with no side effects", async () => {
    const { update, calls } = setup();

    await assert.rejects(
      update({ binaryPaths: { claude: "/usr/bin/claude" } }),
      BINARY_PATHS_ERROR
    );
    assert.equal(calls.flagsChanged, 0);
    assert.deepEqual(calls.cancelReasons, []);
  });

  test("completing onboarding with no sandbox is refused and nothing is persisted", async () => {
    const { update, store, calls } = setup();

    await assert.rejects(
      update({ onboardingCompleted: true }),
      ONBOARDING_SANDBOX_ERROR
    );
    assert.equal(store.getOnboardingCompleted(), false);
    assert.deepEqual(calls.cancelReasons, []);
  });

  test("an invalid origin is refused before the cancel hook runs", async () => {
    const { update, store, calls } = setup();
    const before = store.getRelayOrigin();

    await assert.rejects(
      update({ relayOrigin: "http://example.com" }),
      INVALID_ORIGIN_ERROR
    );
    assert.equal(store.getRelayOrigin(), before);
    assert.deepEqual(calls.cancelReasons, []);
  });
});

describe("desktop:update-settings normalization", () => {
  test("legacy auto tiers fold to high; other rule tiers are kept", async () => {
    const { update } = setup();

    const updated = (await update({
      defaultApprovalTier: "auto",
      autoApprovalRules: { "op-a": "auto", "op-b": "low" },
    })) as DesktopSettings;

    assert.equal(updated.defaultApprovalTier, "high");
    assert.deepEqual(updated.autoApprovalRules, {
      "op-a": "high",
      "op-b": "low",
    });
  });

  test("origins are normalized to their URL origin and the manual-change hook fires", async () => {
    const { update, store, calls } = setup();

    await update({
      relayOrigin: "https://relay.example.com/path/",
      apiOrigin: " https://api.example.com/v1 ",
      webAppOrigin: "https://app.example.com/",
    });

    assert.equal(store.getRelayOrigin(), "https://relay.example.com");
    assert.equal(store.getApiOrigin(), "https://api.example.com");
    assert.equal(store.getWebAppOrigin(), "https://app.example.com");
    assert.deepEqual(calls.cancelReasons, [MANUAL_CHANGE_REASON]);
  });

  test("a non-onboarding update does not fire the manual-change hook", async () => {
    const { update, calls } = setup();

    await update({ defaultApprovalTier: "low" });

    assert.deepEqual(calls.cancelReasons, []);
    assert.equal(calls.flagsChanged, 1);
    assert.equal(calls.socketRestarts, 1);
  });

  test("a non-auto tier is persisted as sent, and a later tier-less update keeps it", async () => {
    const { update, store } = setup();

    await update({ defaultApprovalTier: "low" });
    assert.equal(store.getAll().defaultApprovalTier, "low");

    await update({ onboardingPopupDismissedPermanent: true });
    assert.equal(store.getAll().defaultApprovalTier, "low");
  });

  test("an update that does not send a sandbox leaves the stored sandbox string untouched", async () => {
    const { update, store } = setup();
    const sandbox = fs.realpathSync(makeTempDir("settings-ipc-sandbox-"));
    const storedWithSlash = `${sandbox}${path.sep}`;
    store.update({ sandboxBaseDirectory: storedWithSlash });

    await update({ defaultApprovalTier: "low" });

    // The handler normalizes the stored value only for its own checks; it must
    // not write that normalized form back when the payload carries no sandbox.
    assert.equal(store.getSandboxBaseDirectory(), storedWithSlash);
  });

  test("planExtractionEnabled reaches the store partial", async () => {
    const { update, store } = setup();
    const spy = vi.spyOn(store, "update");

    await update({ planExtractionEnabled: true });

    assert.equal(spy.mock.calls.length, 1);
    const partial = spy.mock.calls[0]?.[0];
    assert.equal(partial?.planExtractionEnabled, true);
  });

  test("golden mode strips cloudConnectionEnabled so neither store nor socket toggles", async () => {
    const { update, store, calls } = setup({ goldenMode: true });

    await update({ cloudConnectionEnabled: false });

    assert.equal(store.getCloudConnectionEnabled(), true);
    assert.deepEqual(calls.setCloudConnectionEnabled, []);
  });
});

describe("desktop:update-settings side effects", () => {
  test("a changed cloudCommandsPaused and cloudConnectionEnabled reach their setters", async () => {
    const { update, store, calls } = setup();

    await update({ cloudCommandsPaused: true, cloudConnectionEnabled: false });

    assert.deepEqual(calls.setCloudCommandsPaused, [true]);
    assert.deepEqual(calls.setCloudConnectionEnabled, [false]);
    assert.equal(store.getCloudCommandsPaused(), true);
    assert.equal(store.getCloudConnectionEnabled(), false);
  });

  test("re-writing the current cloud values calls neither setter", async () => {
    const { update, calls } = setup();

    await update({ cloudCommandsPaused: false, cloudConnectionEnabled: true });

    assert.deepEqual(calls.setCloudCommandsPaused, []);
    assert.deepEqual(calls.setCloudConnectionEnabled, []);
  });

  test("a new sandbox is canonicalized, persisted, and seeded with repos.json", async () => {
    const { update, store, calls } = setup();
    const sandbox = makeSandboxRootTempDir("settings-ipc-sandbox-");

    await update({ sandboxBaseDirectory: `${sandbox}${path.sep}` });

    assert.equal(store.getSandboxBaseDirectory(), sandbox);
    const reposJson = path.join(
      sandbox,
      ".closedloop-ai",
      "config",
      "repos.json"
    );
    const seeded = JSON.parse(fs.readFileSync(reposJson, "utf-8"));
    assert.equal(seeded.settings.worktreeParentDir, sandbox);
    assert.equal(seeded.settings.worktreeParentDirConfirmed, true);
    assert.deepEqual(calls.cancelReasons, [MANUAL_CHANGE_REASON]);
  });

  test("re-setting the same sandbox does not re-seed repos.json", async () => {
    const { update, store } = setup();
    const sandbox = makeSandboxRootTempDir("settings-ipc-sandbox-");
    store.update({ sandboxBaseDirectory: sandbox });

    await update({ sandboxBaseDirectory: sandbox });

    assert.equal(
      fs.existsSync(
        path.join(sandbox, ".closedloop-ai", "config", "repos.json")
      ),
      false
    );
  });

  test("completing onboarding with a stored sandbox succeeds", async () => {
    const { update, store } = setup();
    const sandbox = fs.realpathSync(makeTempDir("settings-ipc-sandbox-"));
    store.update({ sandboxBaseDirectory: sandbox });

    const updated = (await update({
      onboardingCompleted: true,
    })) as DesktopSettings;

    assert.equal(updated.onboardingCompleted, true);
  });

  test("onboardingCompleted false needs no sandbox", async () => {
    const { update, store, calls } = setup();

    await update({ onboardingCompleted: false });

    assert.equal(store.getOnboardingCompleted(), false);
    assert.deepEqual(calls.cancelReasons, [MANUAL_CHANGE_REASON]);
  });
});
