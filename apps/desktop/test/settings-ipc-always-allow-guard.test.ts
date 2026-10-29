/**
 * @file settings-ipc-always-allow-guard.test.ts
 * @description ISS-9175 — `alwaysAllowRules` cannot be written through the
 * generic `desktop:update-settings` path, the store never persists a malformed
 * list, and a malformed list already on disk self-heals on the next
 * GetSettings instead of throwing forever.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { pruneExpiredAlwaysAllowRules } from "../src/main/approvals/always-allow-rules.js";
import { registerApprovalsIpcHandlers } from "../src/main/ipc/approvals-ipc.js";
import { registerSettingsIpcHandlers } from "../src/main/ipc/settings-ipc.js";
import {
  ApiKeyStore,
  type SafeStorageLike,
} from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { ApprovalsIpcChannel } from "../src/shared/approvals-ipc-channel.js";
import type { AlwaysAllowRule } from "../src/shared/contracts.js";
import { SettingsIpcChannel } from "../src/shared/settings-ipc-channel.js";

const FIXED_NOW = Date.parse("2026-01-01T00:00:00.000Z");
const STORE_NAME = "settings";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-ipc-aar-"));
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

function makeRule(overrides: Partial<AlwaysAllowRule> = {}): AlwaysAllowRule {
  return {
    id: "rule-1",
    operationId: "op-1",
    method: "POST",
    path: "/api/write",
    createdAt: new Date(FIXED_NOW).toISOString(),
    expiresAt: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

/**
 * Wire the real handlers over a real SettingsStore in a tmp cwd. `prune` is
 * the REAL pruner by default so the GetSettings self-heal path is exercised
 * end to end; a stub can be passed to isolate the IPC wiring.
 */
function setup(
  options: {
    cwd?: string;
    prune?: (rules: AlwaysAllowRule[] | undefined) => AlwaysAllowRule[];
  } = {}
): {
  cwd: string;
  store: SettingsStore;
  update: (payload: Record<string, unknown>) => Promise<unknown>;
  getSettings: () => Promise<{ alwaysAllowRules: AlwaysAllowRule[] }>;
  setCalls: number[];
} {
  const cwd = options.cwd ?? makeTempDir();
  const store = new SettingsStore({ cwd, name: STORE_NAME });
  const apiKeyStore = new ApiKeyStore({
    cwd,
    name: "secrets",
    safeStorage: makeSafeStorage(),
  });
  const setCalls: number[] = [];
  const originalSet = store.setAlwaysAllowRules.bind(store);
  store.setAlwaysAllowRules = (rules) => {
    setCalls.push(rules.length);
    originalSet(rules);
  };
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
      pruneAlwaysAllowRules:
        options.prune ??
        ((rules) => pruneExpiredAlwaysAllowRules(rules, FIXED_NOW)),
      isGoldenMode: () => false,
      cancelManagedOnboardingForUserChange: () => {},
      getCloudCommandsPaused: () => store.getCloudCommandsPaused(),
      setCloudCommandsPaused: () => {},
      getCloudConnectionEnabled: () => store.getCloudConnectionEnabled(),
      setCloudConnectionEnabled: () => {},
      sendFlagsChanged: () => {},
      restartCloudSocket: () => {},
      restartCollectors: () => {},
    }
  );
  const update = handlers.get(SettingsIpcChannel.UpdateSettings);
  const get = handlers.get(SettingsIpcChannel.GetSettings);
  if (!(update && get)) {
    throw new Error("settings handlers must be registered");
  }
  return {
    cwd,
    store,
    update: (payload) => Promise.resolve(update({}, payload)),
    getSettings: () =>
      Promise.resolve(get({})) as Promise<{
        alwaysAllowRules: AlwaysAllowRule[];
      }>,
    setCalls,
  };
}

/** Write a raw settings JSON file so persisted garbage can be seeded. */
function seedRawStore(cwd: string, alwaysAllowRules: unknown): void {
  fs.writeFileSync(
    path.join(cwd, `${STORE_NAME}.json`),
    JSON.stringify({ alwaysAllowRules }),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Locking tests: behaviour that holds on main today and must keep holding.
// ---------------------------------------------------------------------------

test("prune: keeps a rule that expires after now", () => {
  const rule = makeRule();
  assert.deepEqual(pruneExpiredAlwaysAllowRules([rule], FIXED_NOW), [rule]);
});

test("prune: drops a rule that expired before now", () => {
  const rule = makeRule({
    expiresAt: new Date(FIXED_NOW - 1).toISOString(),
  });
  assert.deepEqual(pruneExpiredAlwaysAllowRules([rule], FIXED_NOW), []);
});

test("prune: a rule expiring exactly now is expired", () => {
  const rule = makeRule({ expiresAt: new Date(FIXED_NOW).toISOString() });
  assert.deepEqual(pruneExpiredAlwaysAllowRules([rule], FIXED_NOW), []);
});

test("prune: drops a rule whose expiresAt does not parse", () => {
  const rule = makeRule({ expiresAt: "not-a-date" });
  assert.deepEqual(pruneExpiredAlwaysAllowRules([rule], FIXED_NOW), []);
});

test("prune: undefined and empty inputs both yield an empty list", () => {
  assert.deepEqual(pruneExpiredAlwaysAllowRules(undefined, FIXED_NOW), []);
  assert.deepEqual(pruneExpiredAlwaysAllowRules([], FIXED_NOW), []);
});

test("GetSettings returns the pruned list and re-persists only when pruning shrank it", async () => {
  const live = makeRule({ id: "live" });
  const dead = makeRule({
    id: "dead",
    expiresAt: new Date(FIXED_NOW - 1).toISOString(),
  });
  const { store, getSettings, setCalls } = setup();
  store.setAlwaysAllowRules([live, dead]);
  setCalls.length = 0;

  const first = await getSettings();
  assert.deepEqual(first.alwaysAllowRules, [live]);
  assert.deepEqual(setCalls, [1], "shrunk list is written back once");
  assert.deepEqual(store.getAll().alwaysAllowRules, [live]);

  const second = await getSettings();
  assert.deepEqual(second.alwaysAllowRules, [live]);
  assert.deepEqual(setCalls, [1], "an already-pruned list is not re-written");
});

test("setAlwaysAllowRules persists a well-formed list", () => {
  const { store } = setup();
  const rule = makeRule();
  store.setAlwaysAllowRules([rule]);
  assert.deepEqual(store.getAll().alwaysAllowRules, [rule]);
});

test("UpdateSettings with an unrelated key leaves alwaysAllowRules untouched", async () => {
  const { store, update } = setup();
  const rule = makeRule();
  store.setAlwaysAllowRules([rule]);
  await update({ verboseLogging: true });
  assert.deepEqual(store.getAll().alwaysAllowRules, [rule]);
});

// ---------------------------------------------------------------------------
// ISS-9175: the guards.
// ---------------------------------------------------------------------------

test("UpdateSettings { alwaysAllowRules: [null] } leaves the stored list unchanged and GetSettings still resolves", async () => {
  const { store, update, getSettings } = setup();
  const rule = makeRule();
  store.setAlwaysAllowRules([rule]);
  await update({ alwaysAllowRules: [null] });
  assert.deepEqual(store.getAll().alwaysAllowRules, [rule]);
  const settings = await getSettings();
  assert.deepEqual(settings.alwaysAllowRules, [rule]);
});

test("UpdateSettings never persists alwaysAllowRules, even a well-formed list", async () => {
  const { store, update } = setup();
  await update({ alwaysAllowRules: [makeRule()] });
  assert.deepEqual(store.getAll().alwaysAllowRules, []);
});

test("SettingsStore.update drops a malformed list without throwing", () => {
  const { store } = setup();
  const rule = makeRule();
  store.setAlwaysAllowRules([rule]);
  store.update({ alwaysAllowRules: [null] as unknown as AlwaysAllowRule[] });
  store.update({
    alwaysAllowRules: [{ id: "x" }] as unknown as AlwaysAllowRule[],
  });
  store.update({ alwaysAllowRules: {} as unknown as AlwaysAllowRule[] });
  assert.deepEqual(store.getAll().alwaysAllowRules, [rule]);
});

test("SettingsStore.update still writes a well-formed list (defence-in-depth arm, no production caller today)", () => {
  const { store } = setup();
  const rule = makeRule();
  store.update({ alwaysAllowRules: [rule] });
  assert.deepEqual(store.getAll().alwaysAllowRules, [rule]);
});

test("getAll() normalizes a persisted non-array container to an empty list and GetSettings resolves", async () => {
  for (const garbage of [null, {}, "rules", 7]) {
    const cwd = makeTempDir();
    seedRawStore(cwd, garbage);
    const { store, getSettings } = setup({ cwd });
    assert.deepEqual(store.getAll().alwaysAllowRules, []);
    const settings = await getSettings();
    assert.deepEqual(settings.alwaysAllowRules, []);
  }
});

test("prune drops a malformed element before dereferencing expiresAt", () => {
  const rule = makeRule();
  const input = [
    null,
    rule,
    42,
    { id: "half" },
  ] as unknown as AlwaysAllowRule[];
  assert.deepEqual(pruneExpiredAlwaysAllowRules(input, FIXED_NOW), [rule]);
});

test("prune keeps a rule with no scopePath and one with a string scopePath", () => {
  const scoped = makeRule({ id: "scoped", scopePath: "/repo" });
  const unscoped = makeRule({ id: "unscoped" });
  assert.deepEqual(
    pruneExpiredAlwaysAllowRules([scoped, unscoped], FIXED_NOW),
    [scoped, unscoped]
  );
});

test("prune drops a rule whose id is blank or whitespace-padded, because it could never be revoked", () => {
  const blank = makeRule({ id: "   " });
  const empty = makeRule({ id: "" });
  const padded = makeRule({ id: " rule-1 " });
  const kept = makeRule({ id: "kept" });
  assert.deepEqual(
    pruneExpiredAlwaysAllowRules([blank, empty, padded, kept], FIXED_NOW),
    [kept]
  );
});

test("a persisted rule with a whitespace-padded id is pruned by GetSettings and removed from disk", async () => {
  const cwd = makeTempDir();
  const padded = makeRule({ id: " rule-1 " });
  const kept = makeRule({ id: "kept" });
  seedRawStore(cwd, [padded, kept]);
  const { store, getSettings } = setup({ cwd });
  const settings = await getSettings();
  assert.deepEqual(settings.alwaysAllowRules, [kept]);
  assert.deepEqual(store.getAll().alwaysAllowRules, [kept]);
});

test("setAlwaysAllowRules drops malformed elements, keeps valid originals with unknown fields, and ignores a non-array", () => {
  const { store } = setup();
  const rule = { ...makeRule(), addedByNewerBuild: "keep-me" };
  store.setAlwaysAllowRules([
    null,
    rule,
    { id: "partial" },
  ] as unknown as AlwaysAllowRule[]);
  assert.deepEqual(store.getAll().alwaysAllowRules, [rule]);
  store.setAlwaysAllowRules({} as unknown as AlwaysAllowRule[]);
  assert.deepEqual(store.getAll().alwaysAllowRules, [rule]);
});

test("a persisted non-array container is rewritten to [] on disk at store open and stays repaired after reopening", () => {
  for (const garbage of [null, {}, "rules", 7]) {
    const cwd = makeTempDir();
    seedRawStore(cwd, garbage);
    const readRaw = () =>
      JSON.parse(fs.readFileSync(path.join(cwd, `${STORE_NAME}.json`), "utf-8"))
        .alwaysAllowRules;
    const opened = new SettingsStore({ cwd, name: STORE_NAME });
    assert.deepEqual(opened.getAll().alwaysAllowRules, []);
    assert.deepEqual(readRaw(), []);
    const reopened = new SettingsStore({ cwd, name: STORE_NAME });
    assert.deepEqual(reopened.getAll().alwaysAllowRules, []);
    assert.deepEqual(readRaw(), []);
  }
});

test("RemoveAlwaysAllowRule over a [null, rule] list on disk does not throw and removes the rule", async () => {
  const cwd = makeTempDir();
  const rule = makeRule({ id: "to-remove" });
  seedRawStore(cwd, [null, rule]);
  const store = new SettingsStore({ cwd, name: STORE_NAME });
  const handlers = new Map<string, IpcHandler>();
  registerApprovalsIpcHandlers(
    {
      handle: (channel: string, listener: IpcHandler) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: () => true,
      approvalStore: {} as never,
      settingsStore: store,
      saveAlwaysAllowRuleForPending: () => {},
    }
  );
  const remove = handlers.get(ApprovalsIpcChannel.RemoveAlwaysAllowRule);
  if (!remove) {
    throw new Error("RemoveAlwaysAllowRule handler must be registered");
  }
  const result = await Promise.resolve(remove({}, "to-remove"));
  assert.deepEqual(result, { alwaysAllowRules: [] });
  assert.deepEqual(store.getAll().alwaysAllowRules, []);
});

test("self-heal end to end: a [null, rule] list on disk is pruned by GetSettings and re-persisted", async () => {
  const cwd = makeTempDir();
  const rule = makeRule();
  seedRawStore(cwd, [null, rule]);
  const { getSettings, setCalls } = setup({ cwd });
  const settings = await getSettings();
  assert.deepEqual(settings.alwaysAllowRules, [rule]);
  assert.deepEqual(setCalls, [1]);
  const reopened = new SettingsStore({ cwd, name: STORE_NAME });
  assert.deepEqual(reopened.getAll().alwaysAllowRules, [rule]);
});

test("additive field round trip: an unknown key on a persisted rule survives GetSettings prune + re-persist byte for byte", async () => {
  const cwd = makeTempDir();
  const future = { ...makeRule(), futureField: { nested: [1, "two"] } };
  seedRawStore(cwd, [null, future]);
  const { getSettings } = setup({ cwd });
  const settings = await getSettings();
  assert.deepEqual(settings.alwaysAllowRules, [future]);
  const raw = JSON.parse(
    fs.readFileSync(path.join(cwd, `${STORE_NAME}.json`), "utf-8")
  ) as { alwaysAllowRules: unknown };
  assert.deepEqual(raw.alwaysAllowRules, [future]);
});
