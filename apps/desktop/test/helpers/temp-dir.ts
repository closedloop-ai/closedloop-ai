import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "node:test";

export function createTempDirManager(prefix: string): {
  makeTempDir: () => string;
} {
  const tempPathsToClean: string[] = [];

  afterEach(async () => {
    for (const p of tempPathsToClean.splice(0)) {
      await fs.rm(p, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempPathsToClean.push(dir);
    return dir;
  }

  return { makeTempDir };
}
