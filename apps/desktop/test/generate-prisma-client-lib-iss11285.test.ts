/**
 * ISS-11285: `isGeneratedClientFresh`'s two fail-closed early returns, driven
 * in a plain `node` child that imports the real module, the way the
 * `generate-prisma-client` entrypoint (a plain-node process) calls it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB_URL = new URL(
  "../scripts/generate-prisma-client-lib.mjs",
  import.meta.url
).href;

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "prisma-fresh-iss11285-"));
  scratchDirs.push(dir);
  writeFileSync(path.join(dir, "index.js"), "");
  return dir;
}

function freshInChild(io: {
  fingerprintFile: string;
  generatedDir: string;
  requiredOutputs: string[];
  fingerprintValue: string;
}): boolean {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const lib = await import(${JSON.stringify(LIB_URL)});\nprocess.stdout.write(JSON.stringify(lib.isGeneratedClientFresh(${JSON.stringify(io)})));`,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`child failed (${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe("isGeneratedClientFresh in a plain node process", () => {
  it("is false when the fingerprint file does not exist, even with every output present", () => {
    const dir = scratch();

    expect(
      freshInChild({
        fingerprintFile: path.join(dir, "missing.fingerprint"),
        generatedDir: dir,
        requiredOutputs: ["index.js"],
        fingerprintValue: "abc",
      })
    ).toBe(false);
  });

  it("is false when the recorded fingerprint differs, and true once it matches", () => {
    const dir = scratch();
    const fingerprintFile = path.join(dir, "client.fingerprint");
    writeFileSync(fingerprintFile, "old\n");
    const io = {
      fingerprintFile,
      generatedDir: dir,
      requiredOutputs: ["index.js"],
      fingerprintValue: "new",
    };

    expect(freshInChild(io)).toBe(false);
    writeFileSync(fingerprintFile, "new\n");
    expect(freshInChild(io)).toBe(true);
  });
});
