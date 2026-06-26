import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  configureBinaryPathsResolver,
  getResolvedClaudePath,
  getResolvedGhPath,
  getResolvedGitPath,
  resetResolvedClaudePath,
} from "../src/server/operations/symphony-loop.js";
import {
  type BinaryName,
  resetShellPathCache,
  resolveBinaryFromLoginShell,
  resolveBinaryFromLoginShellSync,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

const tempDirs: string[] = [];
const originalEnv = saveEnvVars(["PATH", "SHELL", "CL_TEST_SHELL_PATH_OUTPUT"]);

afterEach(() => {
  configureBinaryPathsResolver(null);
  resetResolvedClaudePath();
  resetShellPathCache();
  restoreEnvVars(originalEnv);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeBinary(dir: string, name: BinaryName): string {
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, `#!/bin/sh\necho ${name}\n`, { mode: 0o755 });
  return binPath;
}

function makeFakeShell(): string {
  const dir = makeTempDir("symphony-loop-binary-shell-");
  const shellPath = path.join(dir, "fake-shell");
  fs.writeFileSync(
    shellPath,
    [
      "#!/bin/sh",
      "printf '__CLPATH_START__%s__CLPATH_END__\\n' \"$CL_TEST_SHELL_PATH_OUTPUT\"",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return shellPath;
}

function makeFakeShellEnv(pathOutput: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SHELL: makeFakeShell(),
    CL_TEST_SHELL_PATH_OUTPUT: pathOutput,
    PATH: makeTempDir("symphony-loop-binary-empty-path-"),
  };
}

function setupFakeLoginShellBinaries(): {
  paths: Record<"claude" | "git" | "gh", string>;
  env: NodeJS.ProcessEnv;
} {
  const binDir = makeTempDir("symphony-loop-binary-bin-");
  const paths = {
    claude: makeFakeBinary(binDir, "claude"),
    git: makeFakeBinary(binDir, "git"),
    gh: makeFakeBinary(binDir, "gh"),
  };
  const env = makeFakeShellEnv(binDir);
  configureBinaryPathsResolver(null);
  resetResolvedClaudePath();
  return { paths, env };
}

describe("symphony-loop binary wrappers", () => {
  test("sync wrappers delegate to the shared login-shell resolver", () => {
    const { paths, env } = setupFakeLoginShellBinaries();

    withShellPathEnvForTest(env, () => {
      assert.equal(getResolvedClaudePath(), paths.claude);
      assert.equal(getResolvedGitPath(), paths.git);
      assert.equal(getResolvedGhPath(), paths.gh);
      assert.equal(
        resolveBinaryFromLoginShellSync("claude").path,
        paths.claude
      );
      assert.equal(resolveBinaryFromLoginShellSync("git").path, paths.git);
      assert.equal(resolveBinaryFromLoginShellSync("gh").path, paths.gh);
    });
  });

  test("getResolvedGitPath falls back when the configured override is invalid", () => {
    const { paths, env } = setupFakeLoginShellBinaries();

    withShellPathEnvForTest(env, () => {
      configureBinaryPathsResolver(() => ({
        git: path.join(makeTempDir("symphony-loop-missing-git-"), "git"),
      }));

      assert.equal(getResolvedGitPath(), paths.git);
    });
  });

  test("getResolvedClaudePath matches the async resolver path", async () => {
    const { paths, env } = setupFakeLoginShellBinaries();

    await withShellPathEnvForTest(env, async () => {
      const syncClaudePath = getResolvedClaudePath();
      const asyncClaude = await resolveBinaryFromLoginShell("claude");

      assert.equal(syncClaudePath, paths.claude);
      assert.equal(asyncClaude.source, "path");
      assert.equal(asyncClaude.path, syncClaudePath);
    });
  });
});
