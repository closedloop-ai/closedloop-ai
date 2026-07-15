import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "node:test";

export function createTempDirManager(prefix: string): {
  cleanupTempDirs: () => Promise<void>;
  makeTempDir: (prefixOverride?: string) => string;
} {
  const tempPathsToClean: string[] = [];

  afterEach(cleanupTempDirs);

  async function cleanupTempDirs(): Promise<void> {
    for (const p of tempPathsToClean.splice(0)) {
      await fs.rm(p, { recursive: true, force: true });
    }
  }

  function makeTempDir(prefixOverride?: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefixOverride ?? prefix));
    tempPathsToClean.push(dir);
    return dir;
  }

  return { cleanupTempDirs, makeTempDir };
}
