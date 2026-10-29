/**
 * ISS-11282: branch coverage for `resolveExecutablesOnPath` /
 * `resolveExecutablesOnPathSync` in `src/server/shell-path.ts`. Pins that a
 * repeated PATH segment yields one hit and that a directory or a non-executable
 * file named like the binary is never reported.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExecutablesOnPath,
  resolveExecutablesOnPathSync,
} from "../src/server/shell-path.js";

const BINARY = "iss11282-tool";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function buildSearchPath(): { searchPath: string; executable: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "iss11282-path-scan-"));
  roots.push(root);
  const dirHolder = path.join(root, "a");
  const execHolder = path.join(root, "b");
  const plainHolder = path.join(root, "c");
  mkdirSync(path.join(dirHolder, BINARY), { recursive: true });
  mkdirSync(execHolder, { recursive: true });
  mkdirSync(plainHolder, { recursive: true });
  const executable = path.join(execHolder, BINARY);
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  writeFileSync(path.join(plainHolder, BINARY), "not executable");
  chmodSync(path.join(plainHolder, BINARY), 0o644);
  const searchPath = [
    dirHolder,
    execHolder,
    execHolder,
    ` ${plainHolder} `,
  ].join(path.delimiter);
  return { searchPath, executable };
}

describe("PATH executable scan", () => {
  it("reports a repeated segment once and skips a same-named directory (async)", async () => {
    const { searchPath, executable } = buildSearchPath();

    expect(await resolveExecutablesOnPath(BINARY, searchPath)).toEqual([
      executable,
    ]);
  });

  it("skips a same-named directory and a non-executable file (sync)", () => {
    const { searchPath, executable } = buildSearchPath();

    expect(resolveExecutablesOnPathSync(BINARY, searchPath)).toEqual([
      executable,
    ]);
  });
});
