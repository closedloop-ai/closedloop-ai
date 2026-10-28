/**
 * ISS-5299 — Branch coverage for:
 *   apps/desktop/src/server/operations/symphony-utils.ts (edge cases not covered by symphony-utils.test.ts)
 *
 * Exists as a sibling of the per-module primary suites because each of those is already
 * nearing its responsible line count and this batch is orthogonal to what they cover.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { readLaunchMetadata } from "../src/server/operations/symphony-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "iss5299-plugin-cache-edges-")
  );
  tempDirs.push(dir);
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// symphony-utils.ts — readLaunchMetadata (issueId and ticketTitle branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("readLaunchMetadata — issueId and ticketTitle fields", () => {
  test("parses issueId and ticketTitle string fields when present", async () => {
    const tmpDir = await makeTempDir();
    const workDir = path.join(tmpDir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      path.join(workDir, "launch-metadata.json"),
      JSON.stringify({ issueId: "ISS-9999", ticketTitle: "test ticket title" })
    );

    const meta = await readLaunchMetadata(tmpDir);
    assert.equal(meta?.issueId, "ISS-9999");
    assert.equal(meta?.ticketTitle, "test ticket title");
  });
});
