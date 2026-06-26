import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  buildAllowedChildEnv,
  isHarnessInstalled,
  pickSingleInstallCommand,
} from "../src/main/packs/install-orchestrator.js";
import {
  getShellPathSync,
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import type { CatalogEntry } from "../src/shared/agent-db-contract.js";

const tempDirs: string[] = [];
const trackedEnvKeys = ["PATH", "SHELL"] as const;
const originalEnv = saveEnvVars(trackedEnvKeys);

afterEach(() => {
  restoreEnvVars(originalEnv);
  resetShellPathCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isHarnessInstalled", () => {
  test("returns true for an executable harness binary on the controlled shell PATH", () => {
    const { dir } = makeTempBin("codex", 0o755);

    const installed = withControlledPath(dir, () =>
      isHarnessInstalled("codex")
    );

    assert.equal(installed, true);
  });

  test("returns false when the harness binary is absent from the controlled shell PATH", () => {
    const dir = makeTempDir("install-orchestrator-empty-path-");

    const installed = withControlledPath(dir, () =>
      isHarnessInstalled("claude")
    );

    assert.equal(installed, false);
  });

  test("returns false when the harness binary exists but is not executable", () => {
    const { dir } = makeTempBin("claude", 0o644);

    const installed = withControlledPath(dir, () =>
      isHarnessInstalled("claude")
    );

    assert.equal(installed, false);
  });

  test("returns false for an unknown harness name", () => {
    const { dir } = makeTempBin("codex", 0o755);

    const installed = withControlledPath(dir, () =>
      isHarnessInstalled("unknown")
    );

    assert.equal(installed, false);
  });

  test("uses the same resolved shell PATH for harness selection and install env", () => {
    const { dir: shellBinDir } = makeTempBin("codex", 0o755);
    const inheritedPath = makeTempDir("install-orchestrator-inherited-path-");
    const fakeShell = makeFakeShell("install-orchestrator-fake-shell-");

    const result = withShellPathEnvForTest(
      {
        ...process.env,
        PATH: inheritedPath,
        SHELL: fakeShell,
        CL_TEST_SHELL_PATH_OUTPUT: shellBinDir,
      },
      () => {
        const childEnv = buildAllowedChildEnv(
          process.env,
          null,
          getShellPathSync()
        );
        const picked = pickSingleInstallCommand(
          makeSingleInstallCatalogEntry(),
          "install",
          childEnv
        );

        return {
          installed: isHarnessInstalled("codex", childEnv),
          path: childEnv.PATH,
          picked,
        };
      }
    );

    assert.equal(result.path, shellBinDir);
    assert.equal(result.installed, true);
    assert.equal(result.picked.command, "codex install");
    assert.deepEqual(result.picked.registerHarnesses, ["codex"]);
  });
});

function withControlledPath<T>(binDir: string, fn: () => T): T {
  return withShellPathEnvForTest({ ...process.env, PATH: binDir }, () => {
    setShellPathForTest();
    return fn();
  });
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTempBin(
  name: string,
  mode: number
): { binPath: string; dir: string } {
  const dir = makeTempDir("install-orchestrator-bin-");
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", { mode });
  return { binPath, dir };
}

function makeFakeShell(prefix: string): string {
  const dir = makeTempDir(prefix);
  const shellPath = path.join(dir, "shell");
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

function makeSingleInstallCatalogEntry(): CatalogEntry {
  return {
    category: null,
    contents: null,
    contentsCache: null,
    description: null,
    descriptionLive: null,
    detectionPatterns: null,
    displayName: "GStack",
    forks: null,
    githubUrl: "https://github.com/example/gstack",
    harnessAgnostic: false,
    harnesses: ["claude", "codex"],
    history: [],
    installCommands: {
      claude: "claude install",
      codex: "codex install",
    },
    installNotes: null,
    installedHarnesses: [],
    lastRelease: null,
    marketplaceUrl: null,
    packId: "gstack",
    pinOrder: null,
    placeholderReason: null,
    postInstall: null,
    projectScoped: false,
    readmeExcerpt: null,
    seedVersion: 1,
    singleInstall: true,
    skillCount: 0,
    stars: null,
    uninstallCommands: {},
    usageCount: 0,
    verified: true,
  };
}

function saveEnvVars(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvVars(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
      continue;
    }
    process.env[key] = value;
  }
}
