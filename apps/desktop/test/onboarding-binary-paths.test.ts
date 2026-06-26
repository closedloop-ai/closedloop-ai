/**
 * T-4.3: Onboarding binary path configuration tests.
 *
 * These tests cover the SettingsStore.patchBinaryPaths behavior used by the
 * desktop:complete-onboarding IPC handler when binaryPaths is provided.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsStore } from "../src/main/settings-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStore(initial: Record<string, unknown> = {}): {
  store: SettingsStore;
  tmpDir: string;
} {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "onboarding-binary-paths-")
  );
  tempDirs.push(tmpDir);
  const storeName = "test-settings";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify(initial)
  );
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  return { store, tmpDir };
}

// --- patchBinaryPaths: write and read ---

test("patchBinaryPaths persists claude and git paths", () => {
  const { store } = makeTempStore();
  store.patchBinaryPaths({
    claude: "/absolute/path/to/claude",
    git: "/usr/bin/git",
  });
  const paths = store.getBinaryPaths();
  assert.equal(paths.claude, "/absolute/path/to/claude");
  assert.equal(paths.git, "/usr/bin/git");
});

test("patchBinaryPaths: completing onboarding with binaryPaths persists them", () => {
  const { store } = makeTempStore();
  // Simulate what the IPC handler does: filter non-blank keys and patch
  const binaryPaths = {
    claude: "/absolute/path/to/claude",
    git: "/usr/bin/git",
  };
  const patch: Partial<
    Record<
      "claude" | "gh" | "codex" | "cursor" | "opencode" | "python3" | "git",
      string | null
    >
  > = {};
  for (const key of [
    "claude",
    "gh",
    "codex",
    "cursor",
    "opencode",
    "python3",
    "git",
  ] as const) {
    const value = binaryPaths[key as keyof typeof binaryPaths];
    if (typeof value === "string" && value.trim()) {
      patch[key] = value.trim();
    }
  }
  store.patchBinaryPaths(patch as Record<string, string | null>);
  const paths = store.getBinaryPaths();
  assert.equal(paths.claude, "/absolute/path/to/claude");
  assert.equal(paths.git, "/usr/bin/git");
  assert.equal(paths.gh, undefined);
  assert.equal(paths.codex, undefined);
  assert.equal(paths.cursor, undefined);
  assert.equal(paths.opencode, undefined);
  assert.equal(paths.python3, undefined);
});

test("patchBinaryPaths: completing onboarding without binaryPaths writes nothing", () => {
  const { store } = makeTempStore();
  // No binaryPaths in payload -- getBinaryPaths returns empty object
  const paths = store.getBinaryPaths();
  assert.deepEqual(paths, {});
});

test("patchBinaryPaths: empty string values are excluded before patching", () => {
  const { store } = makeTempStore();
  // Simulate IPC handler: empty strings are skipped, not passed to patch
  const binaryPaths = { claude: "", git: "/usr/bin/git" };
  const patch: Partial<
    Record<
      "claude" | "gh" | "codex" | "cursor" | "opencode" | "python3" | "git",
      string | null
    >
  > = {};
  for (const key of [
    "claude",
    "gh",
    "codex",
    "cursor",
    "opencode",
    "python3",
    "git",
  ] as const) {
    const value = binaryPaths[key as keyof typeof binaryPaths];
    if (typeof value === "string" && value.trim()) {
      patch[key] = value.trim();
    }
  }
  if (Object.keys(patch).length > 0) {
    store.patchBinaryPaths(patch as Record<string, string | null>);
  }
  const paths = store.getBinaryPaths();
  assert.equal(
    paths.claude,
    undefined,
    "empty claude path should not be written"
  );
  assert.equal(
    paths.git,
    "/usr/bin/git",
    "non-empty git path should be written"
  );
});

test("patchBinaryPaths: null value removes a previously set path", () => {
  const { store } = makeTempStore();
  store.patchBinaryPaths({ claude: "/some/path/claude" });
  assert.equal(store.getBinaryPaths().claude, "/some/path/claude");
  store.patchBinaryPaths({ claude: null });
  assert.equal(store.getBinaryPaths().claude, undefined);
});

test("patchBinaryPaths: does not disturb other settings", () => {
  const { store } = makeTempStore({
    sandboxBaseDirectory: "/Users/test/Source",
    webAppOrigin: "https://app.example.test",
  });
  store.patchBinaryPaths({ claude: "/absolute/path/to/claude" });
  const all = store.getAll();
  assert.equal(all.sandboxBaseDirectory, "/Users/test/Source");
  assert.equal(all.webAppOrigin, "https://app.example.test");
});

test("getBinaryPaths returns empty object when never set", () => {
  const { store } = makeTempStore();
  assert.deepEqual(store.getBinaryPaths(), {});
});
