import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { isPathAllowed } from "../src/server/security.js";

const tempPaths: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPaths.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

test("rejects symlink escape outside allowed directory", async () => {
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-security-symlink-")
  );
  tempPaths.push(tmpRoot);

  const allowedRoot = path.join(tmpRoot, "allowed");
  const outsideRoot = path.join(tmpRoot, "outside");
  await fs.mkdir(allowedRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });

  const symlinkPath = path.join(allowedRoot, "escape-link");
  await fs.symlink(outsideRoot, symlinkPath, "dir");

  const escapedTarget = path.join(symlinkPath, "file.txt");
  assert.equal(isPathAllowed(escapedTarget, [allowedRoot]), false);
});

test("denies sensitive paths even when parent directory is broadly allowed", () => {
  const sensitiveTarget = path.join(os.homedir(), ".ssh", "config");
  assert.equal(isPathAllowed(sensitiveTarget, [os.homedir()]), false);
});
