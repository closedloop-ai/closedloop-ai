/**
 * ISS-11285: the module's own CLI block, which runs the preflight on import
 * when `process.argv[1]` names this script. Each case re-imports the module
 * with `argv[1]` pointed at it so the top-level guard runs in-process.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/assert-supported-node.mjs", import.meta.url)
);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..", "..");
const PINNED_VERSION = readFileSync(
  path.join(REPO_ROOT, ".nvmrc"),
  "utf8"
).trim();
const UNSUPPORTED_NODE = "10.0.0";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalNodeVersion = Object.getOwnPropertyDescriptor(
  process.versions,
  "node"
);

function setNodeVersion(version: string): void {
  Object.defineProperty(process.versions, "node", {
    ...originalNodeVersion,
    value: version,
  });
}

async function importAsCli(): Promise<string> {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  process.argv = [originalArgv[0], SCRIPT_PATH];
  vi.resetModules();
  await import("../scripts/assert-supported-node.mjs");
  return writes.join("");
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalNodeVersion) {
    Object.defineProperty(process.versions, "node", originalNodeVersion);
  }
});

describe("assert-supported-node run as the CLI", () => {
  it("prints the remedy naming the pinned version and sets exit code 1 on an unsupported Node", async () => {
    setNodeVersion(UNSUPPORTED_NODE);

    const stderr = await importAsCli();

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain(UNSUPPORTED_NODE);
    expect(stderr).toContain(`pins Node ${PINNED_VERSION} in .nvmrc`);
  });

  it("stays silent and leaves the exit code unset on the running (supported) Node", async () => {
    const stderr = await importAsCli();

    expect(process.exitCode).toBeUndefined();
    expect(stderr).toBe("");
  });
});
