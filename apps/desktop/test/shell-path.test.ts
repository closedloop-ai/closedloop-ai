import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeOtelEnvVar } from "../src/server/otel/claude-code-env.js";
import {
  expandTildes,
  extractPathFromOutput,
  getShellEnv,
  getShellPath,
  getShellPathSync,
  resetShellPathCache,
  resetShellPathCacheOnlyForTest,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

const originalEnv = saveEnvVars([
  "PATH",
  "SHELL",
  "CL_TEST_SHELL_PATH_OUTPUT",
  "CL_TEST_SHELL_COUNTER",
]);

afterEach(() => {
  restoreEnvVars(originalEnv);
  resetShellPathCache();
});

async function writeFakeShell(tempDir: string): Promise<string> {
  const fakeShell = path.join(tempDir, "fake-shell");
  await writeFile(
    fakeShell,
    [
      "#!/bin/sh",
      'if [ -n "$CL_TEST_SHELL_COUNTER" ]; then',
      "  count=$(cat \"$CL_TEST_SHELL_COUNTER\" 2>/dev/null || printf '0')",
      "  count=$((count + 1))",
      '  printf \'%s\' "$count" > "$CL_TEST_SHELL_COUNTER"',
      "fi",
      "printf '__CLPATH_START__%s__CLPATH_END__\\n' \"$CL_TEST_SHELL_PATH_OUTPUT\"",
      "",
    ].join("\n")
  );
  await chmod(fakeShell, 0o755);
  return fakeShell;
}

describe("expandTildes", () => {
  const home = os.homedir();

  test("expands ~/bin to absolute path", () => {
    assert.equal(expandTildes("~/bin"), `${home}/bin`);
  });

  test("expands ~ alone to home directory", () => {
    assert.equal(expandTildes("~"), home);
  });

  test("expands multiple tilde segments", () => {
    const result = expandTildes("/usr/bin:~/bin:~/.local/bin:/usr/local/bin");
    assert.equal(
      result,
      `/usr/bin:${home}/bin:${home}/.local/bin:/usr/local/bin`
    );
  });

  test("does not expand ~ in the middle of a segment", () => {
    assert.equal(expandTildes("/some/path/~stuff"), "/some/path/~stuff");
  });

  test("does not expand ~user syntax (only bare ~)", () => {
    assert.equal(expandTildes("~otheruser/bin"), "~otheruser/bin");
  });

  test("handles empty string", () => {
    assert.equal(expandTildes(""), "");
  });

  test("handles path with no tildes", () => {
    const input = "/usr/bin:/usr/local/bin";
    assert.equal(expandTildes(input), input);
  });
});

describe("extractPathFromOutput", () => {
  const pathValue = "/usr/bin:/usr/local/bin:/opt/homebrew/bin";

  test("extracts PATH from clean output with sentinels", () => {
    const stdout = `__CLPATH_START__${pathValue}__CLPATH_END__\n`;
    assert.equal(extractPathFromOutput(stdout), pathValue);
  });

  test("extracts PATH when shell startup chatter precedes sentinels", () => {
    const stdout = [
      "Restored session: Fri Mar 27 10:32:24 CDT 2026",
      "Last login: Thu Mar 26 09:00:00 on ttys001",
      `__CLPATH_START__${pathValue}__CLPATH_END__`,
      "",
    ].join("\n");
    assert.equal(extractPathFromOutput(stdout), pathValue);
  });

  test("extracts PATH when chatter appears after sentinels too", () => {
    const stdout = [
      "conda activate base",
      `__CLPATH_START__${pathValue}__CLPATH_END__`,
      "some trailing warning",
      "",
    ].join("\n");
    assert.equal(extractPathFromOutput(stdout), pathValue);
  });

  test("falls back to last non-empty line when sentinels are missing", () => {
    const stdout = `some noise\n${pathValue}\n`;
    assert.equal(extractPathFromOutput(stdout), pathValue);
  });

  test("returns empty string for empty output without sentinels", () => {
    assert.equal(extractPathFromOutput(""), "");
    assert.equal(extractPathFromOutput("\n\n"), "");
  });
});

describe("getShellPath", () => {
  test("returns a non-empty string", async () => {
    const result = await getShellPath();
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  test("includes standard system paths", async () => {
    const result = await getShellPath();
    assert.ok(result.includes("/usr/bin"), "Expected /usr/bin in PATH");
  });

  test("does not contain shell startup noise or sentinels", async () => {
    const result = await getShellPath();
    assert.ok(
      !result.includes("__CLPATH_START__"),
      "Should not contain start sentinel"
    );
    assert.ok(
      !result.includes("__CLPATH_END__"),
      "Should not contain end sentinel"
    );
    assert.ok(
      !result.includes("Restored session"),
      "Should not contain shell startup chatter"
    );
    assert.ok(!result.includes("\n"), "Should not contain newlines");
  });

  test("does not contain unexpanded tildes", async () => {
    const result = await getShellPath();
    const segments = result.split(":");
    for (const seg of segments) {
      assert.ok(
        !seg.startsWith("~/"),
        `PATH segment should not start with ~/: ${seg}`
      );
      assert.ok(seg !== "~", "PATH segment should not be bare ~");
    }
  });

  test("returns the same value on subsequent calls (caching)", async () => {
    const first = await getShellPath();
    const second = await getShellPath();
    assert.equal(first, second);
  });

  test("cache can be reset", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "shell-path-test-"));
    const fakeShell = path.join(tempDir, "fake-shell");
    await writeFile(
      fakeShell,
      [
        "#!/bin/sh",
        "printf '__CLPATH_START__%s__CLPATH_END__\\n' \"$CL_TEST_SHELL_PATH_OUTPUT\"",
      ].join("\n")
    );
    await chmod(fakeShell, 0o755);

    try {
      const env = {
        ...process.env,
        SHELL: fakeShell,
        CL_TEST_SHELL_PATH_OUTPUT: "/tmp/fake-bin-1:/usr/bin",
      };

      await withShellPathEnvForTest(env, async () => {
        const first = await getShellPath();
        env.CL_TEST_SHELL_PATH_OUTPUT = "/tmp/fake-bin-2:/usr/bin";
        const cached = await getShellPath();

        assert.equal(first, "/tmp/fake-bin-1:/usr/bin");
        assert.equal(cached, first);

        resetShellPathCacheOnlyForTest();
        const second = await getShellPath();
        assert.equal(second, "/tmp/fake-bin-2:/usr/bin");
      });
    } finally {
      resetShellPathCache();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("test PATH pins are isolated across async contexts", async () => {
    async function readPinnedPath(
      shellPath: string,
      waitMs: number
    ): Promise<string> {
      return await withShellPathEnvForTest(
        { ...process.env, PATH: shellPath },
        async () => {
          setShellPathForTest();
          await delay(waitMs);

          assert.equal(getShellPathSync(), shellPath);
          return await getShellPath();
        }
      );
    }

    const firstPath = "/tmp/context-shell-a:/usr/bin";
    const secondPath = "/tmp/context-shell-b:/usr/bin";

    const [first, second] = await Promise.all([
      readPinnedPath(firstPath, 10),
      readPinnedPath(secondPath, 0),
    ]);

    assert.equal(first, firstPath);
    assert.equal(second, secondPath);
  });
});

describe("getShellPathSync", () => {
  test("extracts sentinels and expands tildes", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-sync-test-")
    );
    try {
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: "~/fake-bin:/usr/bin",
      };

      const result = withShellPathEnvForTest(env, () => getShellPathSync());

      assert.equal(result, `${os.homedir()}/fake-bin:/usr/bin`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back when the configured shell is missing", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-sync-missing-")
    );
    try {
      const env = {
        ...process.env,
        PATH: "/tmp/fallback-bin",
        SHELL: path.join(tempDir, "missing-shell"),
      };

      const result = withShellPathEnvForTest(env, () => getShellPathSync());

      assert.equal(
        result,
        "/tmp/fallback-bin:/opt/homebrew/bin:/usr/local/bin"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("shares cache after async resolves first", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-cache-async-first-")
    );
    const counterPath = path.join(tempDir, "counter");
    try {
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: "/tmp/cache-async-first:/usr/bin",
        CL_TEST_SHELL_COUNTER: counterPath,
      };

      await withShellPathEnvForTest(env, async () => {
        const first = await getShellPath();
        const second = getShellPathSync();

        assert.equal(first, "/tmp/cache-async-first:/usr/bin");
        assert.equal(second, first);
        assert.equal(await readFile(counterPath, "utf8"), "1");
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("shares cache after sync resolves first", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-cache-sync-first-")
    );
    const counterPath = path.join(tempDir, "counter");
    try {
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: "/tmp/cache-sync-first:/usr/bin",
        CL_TEST_SHELL_COUNTER: counterPath,
      };

      await withShellPathEnvForTest(env, async () => {
        const first = getShellPathSync();
        const second = await getShellPath();

        assert.equal(first, "/tmp/cache-sync-first:/usr/bin");
        assert.equal(second, first);
        assert.equal(await readFile(counterPath, "utf8"), "1");
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reset clears sync and async cache state", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-cache-reset-")
    );
    try {
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: "/tmp/cache-reset-1:/usr/bin",
      };

      await withShellPathEnvForTest(env, async () => {
        const first = getShellPathSync();
        env.CL_TEST_SHELL_PATH_OUTPUT = "/tmp/cache-reset-2:/usr/bin";
        const cached = await getShellPath();
        resetShellPathCacheOnlyForTest();
        const second = await getShellPath();

        assert.equal(first, "/tmp/cache-reset-1:/usr/bin");
        assert.equal(cached, first);
        assert.equal(second, "/tmp/cache-reset-2:/usr/bin");
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("getShellEnv", () => {
  test("returns an object with PATH set", async () => {
    const env = await getShellEnv();
    assert.ok(typeof env.PATH === "string");
    assert.ok(env.PATH.includes("/usr/bin"));
  });

  test("includes process.env values", async () => {
    const env = await getShellEnv();
    // HOME should be inherited from process.env
    assert.ok(env.HOME === process.env.HOME);
  });

  test("merges extra keys into the env", async () => {
    const env = await getShellEnv({ MY_CUSTOM_VAR: "test-value" });
    assert.equal(env.MY_CUSTOM_VAR, "test-value");
  });

  test("extra keys override process.env", async () => {
    const env = await getShellEnv({ HOME: "/tmp/fake-home" });
    assert.equal(env.HOME, "/tmp/fake-home");
  });

  test("PATH comes from getShellPath, not process.env", async () => {
    const shellPath = await getShellPath();
    const env = await getShellEnv();
    assert.equal(env.PATH, shellPath);
  });

  test("does not synthesize Claude Code OTel env keys", async () => {
    const env = await withShellPathEnvForTest(
      {
        PATH: "/usr/bin",
        SHELL: "/bin/sh",
        HOME: "/tmp/closedloop-shell-test-home",
      },
      async () => {
        setShellPathForTest();
        return await getShellEnv();
      }
    );

    for (const key of Object.values(ClaudeCodeOtelEnvVar)) {
      assert.equal(Object.hasOwn(env, key), false);
    }
  });
});
