/**
 * ISS-11596 (PLN-2165 T-3.1): `getResolvedClaudePathAsync()` answers exactly
 * what `getResolvedClaudePath()` answers in every branch, so the two main-thread
 * callers that moved to it (`attemptLlmCommit`, `runBootstrapProcess`) spawn
 * the same binary. The async export does not exist before this change, which
 * is why this pin is not part of the call-site characterization files.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  configureBinaryPathsResolver,
  getResolvedClaudePath,
  getResolvedClaudePathAsync,
} from "../src/server/operations/binary-path-overrides.js";
import {
  _setKnownBinaryLocationsForResolverTest,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { createGitOpTempDirs } from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss11596-claude-pair-");

afterEach(() => {
  configureBinaryPathsResolver(null);
  _setKnownBinaryLocationsForResolverTest(null);
});

async function executable(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

/** Both resolvers' answers, read with `pathDir` as the login-shell PATH. */
async function bothAnswers(pathDir: string): Promise<[string, string]> {
  return await withShellPathEnvForTest(
    { ...process.env, PATH: pathDir },
    async () => {
      setShellPathForTest();
      return [getResolvedClaudePath(), await getResolvedClaudePathAsync()];
    }
  );
}

describe("getResolvedClaudePathAsync mirrors getResolvedClaudePath", () => {
  test("a usable override", async () => {
    const root = makeTempDir();
    const override = await executable(path.join(root, "override"), "claude");
    configureBinaryPathsResolver(() => ({ claude: override }));

    assert.deepEqual(await bothAnswers(path.join(root, "empty")), [
      override,
      override,
    ]);
  });

  test("an unusable override is returned as-is by both", async () => {
    const root = makeTempDir();
    const override = path.join(root, "missing", "claude");
    configureBinaryPathsResolver(() => ({ claude: override }));

    assert.deepEqual(await bothAnswers(path.join(root, "empty")), [
      override,
      override,
    ]);
  });

  test("a claude on the login-shell PATH", async () => {
    const root = makeTempDir();
    const onPath = await executable(path.join(root, "bin"), "claude");
    _setKnownBinaryLocationsForResolverTest({ claude: [] });

    assert.deepEqual(await bothAnswers(path.join(root, "bin")), [
      onPath,
      onPath,
    ]);
  });

  test("a claude found only at a known install location", async () => {
    const root = makeTempDir();
    const known = await executable(path.join(root, "known"), "claude");
    _setKnownBinaryLocationsForResolverTest({ claude: [known] });

    assert.deepEqual(await bothAnswers(path.join(root, "empty")), [
      known,
      known,
    ]);
  });

  test("the bare name when nothing is found", async () => {
    const root = makeTempDir();
    _setKnownBinaryLocationsForResolverTest({ claude: [] });

    assert.deepEqual(await bothAnswers(path.join(root, "empty")), [
      "claude",
      "claude",
    ]);
  });
});
