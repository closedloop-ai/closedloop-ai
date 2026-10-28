/**
 * @file transcript-checksums.test.ts
 * @description FEA-2715 newline-boundary helper coverage. Verifies that a
 * transcript window is cut at the last complete newline.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { findNewlineBoundary } from "../src/main/transcript-sync/transcript-checksums.js";

function withTempFile(
  name: string,
  bytes: Buffer,
  run: (path: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "transcript-checksums-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("findNewlineBoundary returns the offset past the last complete line", async () => {
  await withTempFile(
    "lines.jsonl",
    Buffer.from("aaa\nbbb\nccc"),
    async (path) => {
      // "aaa\nbbb\nccc" — last '\n' at index 7, so the boundary is 8; the partial
      // "ccc" tail is excluded.
      assert.equal(await findNewlineBoundary(path, 11), 8);
    }
  );
});

test("findNewlineBoundary is 0 when the window has no newline", async () => {
  await withTempFile(
    "noline.jsonl",
    Buffer.from("partial line"),
    async (path) => {
      assert.equal(await findNewlineBoundary(path, 12), 0);
    }
  );
});

test("findNewlineBoundary includes a trailing newline", async () => {
  await withTempFile("trail.jsonl", Buffer.from("aaa\n"), async (path) => {
    assert.equal(await findNewlineBoundary(path, 4), 4);
  });
});
