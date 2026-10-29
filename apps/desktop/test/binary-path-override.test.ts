import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { applyBinaryPathPatchAndInvalidateCaches } from "../src/main/settings/binary-path-override.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy gh null patch removes a persisted override", () => {
  const store = makeTempStore({
    binaryPaths: {
      claude: "/absolute/path/to/claude",
      gh: "/absolute/path/to/gh",
    },
  });

  const result = applyBinaryPathPatchAndInvalidateCaches(store, {
    gh: null,
  } as Record<string, string | null>);

  assert.deepEqual(result, { claude: "/absolute/path/to/claude" });
  assert.equal(store.getBinaryPaths().gh, undefined);
  assert.equal(store.getBinaryPaths().claude, "/absolute/path/to/claude");
});

test("legacy gh string patch cannot add or replace an override", () => {
  const store = makeTempStore({
    binaryPaths: {
      gh: "/absolute/path/to/gh",
    },
  });

  const result = applyBinaryPathPatchAndInvalidateCaches(store, {
    gh: "/other/path/to/gh",
  } as Record<string, string | null>);

  assert.deepEqual(result, {});
  assert.equal(store.getBinaryPaths().gh, "/absolute/path/to/gh");
});

function makeTempStore(initial: Record<string, unknown>): SettingsStore {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "binary-path-override-")
  );
  tempDirs.push(tmpDir);
  const storeName = "test-settings";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify(initial)
  );
  return new SettingsStore({ cwd: tmpDir, name: storeName });
}
