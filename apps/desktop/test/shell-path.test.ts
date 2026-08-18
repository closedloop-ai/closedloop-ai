import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeOtelEnvVar } from "../src/server/otel/claude-code-env.js";
import {
  _setKnownBinaryLocationsForResolverTest,
  expandTildes,
  extractPathFromOutput,
  getShellEnv,
  getShellPath,
  getShellPathSync,
  resetShellPathCache,
  resetShellPathCacheOnlyForTest,
  resolveBinaryFromLoginShellSync,
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

  test("a probe left in flight by a reset does not overwrite a later pin", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "shell-path-pin-"));
    const counterFile = path.join(tempDir, "shell-spawn-count");
    const spawnCount = async (): Promise<string> =>
      await readFile(counterFile, "utf8").catch(() => "0");
    try {
      const staleLoginShellPath = "/tmp/stale-login-shell:/usr/bin";
      process.env.SHELL = await writeFakeShell(tempDir);
      process.env.CL_TEST_SHELL_PATH_OUTPUT = staleLoginShellPath;
      process.env.CL_TEST_SHELL_COUNTER = counterFile;
      resetShellPathCache();

      // Background work resolving a login shell against the old env, which the
      // pin below then supersedes. The reset above ran first, so this case is
      // about `adoptShellPath` superseding a probe; a reset landing *during*
      // one is the case below.
      const inFlight = getShellPath();

      // The next case pins its own PATH from inside an awaited helper — where
      // `setShellPathForTest`'s AsyncLocalStorage pin cannot reach its caller,
      // so only module-level state carries it. ISS-6380.
      const pinnedPath = "/tmp/pinned-fake-bin:/usr/bin";
      await (async () => {
        await Promise.resolve();
        process.env.PATH = pinnedPath;
        setShellPathForTest();
      })();

      const supersededWaiter = await inFlight;
      const spawnsBefore = await spawnCount();

      // Both halves, because either alone lets the other regress: the
      // superseded waiter answers with the PATH its own probe resolved, and
      // the cache still holds the pin that superseded it. Handing the waiter
      // the slot's newer value would route work that started under the old
      // environment through the pinned fake-bin dir. ISS-6380.
      assert.equal(supersededWaiter, staleLoginShellPath);
      assert.equal(await getShellPath(), pinnedPath);
      assert.equal(getShellPathSync(), pinnedPath);
      // The value being right is not enough. A superseded probe that still
      // wrote its answer would leave the cache empty-or-stale, and the next
      // call would go back to the login shell — so assert that no further
      // shell was spawned, not just that this call returned the pin.
      assert.equal(
        await spawnCount(),
        spawnsBefore,
        "a pinned PATH must not spawn another login shell"
      );
    } finally {
      restoreEnvVars(originalEnv);
      resetShellPathCache();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("a reset during a probe keeps that probe's result out of the cache", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-inflight-")
    );
    const counterPath = path.join(tempDir, "counter");
    const preResetPath = "/tmp/pre-reset-probe:/usr/bin";
    const postResetPath = "/tmp/post-reset-probe:/usr/bin";
    try {
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: preResetPath,
        CL_TEST_SHELL_COUNTER: counterPath,
      };

      await withShellPathEnvForTest(env, async () => {
        // `getShellPath()` spawns its shell before it returns, and nothing is
        // awaited between here and the reset — so the reset provably lands
        // while this probe is in flight. Sequencing gates the race instead of a
        // held-open shell: no handle to leak if an assertion below throws.
        const inFlight = getShellPath();
        resetShellPathCacheOnlyForTest();

        // Only a later spawn can see this; the in-flight child already holds
        // its own copy of the env.
        env.CL_TEST_SHELL_PATH_OUTPUT = postResetPath;

        assert.equal(await inFlight, preResetPath);
        // Nothing pins a PATH anywhere in this test, so no later write can
        // stand in for the invalidation: had the reset failed to disown the
        // probe, the probe's own result would be sitting in the cache and this
        // call would return it instead of resolving again.
        assert.equal(await getShellPath(), postResetPath);
        assert.equal(
          await readFile(counterPath, "utf8"),
          "2",
          "the invalidated probe must not spare the next call a login shell"
        );
      });
    } finally {
      resetShellPathCache();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("an earlier pin does not leak into a context that resolves for itself", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "shell-path-leak-"));
    try {
      process.env.PATH = "/tmp/earlier-pin:/usr/bin";
      setShellPathForTest();

      // A scope that deliberately does NOT pin wants its own fake shell to be
      // consulted. Holding a pin anywhere outside this slot would answer with
      // the earlier pin instead and defeat the per-context isolation.
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: "/tmp/context-owned:/usr/bin",
      };
      const resolved = await withShellPathEnvForTest(
        env,
        async () => await getShellPath()
      );

      assert.equal(resolved, "/tmp/context-owned:/usr/bin");
    } finally {
      restoreEnvVars(originalEnv);
      resetShellPathCache();
      await rm(tempDir, { recursive: true, force: true });
    }
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

  test("a sync lookup during an async probe outlives that probe", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-sync-during-async-")
    );
    const asyncProbePath = "/tmp/async-probe:/usr/bin";
    const syncLookupPath = "/tmp/sync-lookup:/usr/bin";
    try {
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: asyncProbePath,
      };

      await withShellPathEnvForTest(env, async () => {
        // The sync lookup cannot await the in-flight probe, so it resolves for
        // itself and publishes. Nothing is awaited between the two calls, so
        // the probe is provably still running when the sync value is adopted —
        // and provably still running afterwards, since its continuation cannot
        // interleave with a synchronous call.
        const inFlight = getShellPath();
        env.CL_TEST_SHELL_PATH_OUTPUT = syncLookupPath;
        const syncPath = getShellPathSync();

        // A third value no call below should ever return: it separates "the
        // sync value was still cached" from "the cache was empty and something
        // resolved again", which the sync value alone cannot distinguish.
        env.CL_TEST_SHELL_PATH_OUTPUT = "/tmp/never-resolved:/usr/bin";

        assert.equal(syncPath, syncLookupPath);
        assert.equal(await inFlight, asyncProbePath);
        assert.equal(await getShellPath(), syncLookupPath);
        assert.equal(getShellPathSync(), syncLookupPath);
      });
    } finally {
      resetShellPathCache();
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

// ISS-5299: async SHELL_ARG_VARIANTS catch branch (line 101), full-fallback
// (line 105), and concurrent in-flight promise sharing (line 139).
describe("getShellPath async variant fallback", () => {
  test("uses -lc variant when -ilc fails", async () => {
    // A shell that exits 1 for -ilc but succeeds for -lc hits the catch block
    // at the end of the first SHELL_ARG_VARIANTS iteration (line 101) and then
    // returns the sentinel output on the second iteration.
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-ilc-fail-")
    );
    const fakeShell = path.join(tempDir, "fail-ilc-shell");
    await writeFile(
      fakeShell,
      [
        "#!/bin/sh",
        'if [ "$1" = "-ilc" ]; then exit 1; fi',
        "printf '__CLPATH_START__%s__CLPATH_END__\\n' \"$CL_TEST_SHELL_PATH_OUTPUT\"",
        "",
      ].join("\n")
    );
    await chmod(fakeShell, 0o755);
    try {
      const result = await withShellPathEnvForTest(
        {
          ...process.env,
          SHELL: fakeShell,
          CL_TEST_SHELL_PATH_OUTPUT: "/tmp/lc-succeeded:/usr/bin",
        },
        async () => getShellPath()
      );
      assert.equal(result, "/tmp/lc-succeeded:/usr/bin");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns fallback PATH when all shell arg variants fail", async () => {
    // All SHELL_ARG_VARIANTS fail → the loop exhausts → shellPathFallback is
    // returned (line 105).  Both catch arms at line 101 also fire.
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-all-fail-")
    );
    const fakeShell = path.join(tempDir, "always-fail-shell");
    await writeFile(fakeShell, ["#!/bin/sh", "exit 1", ""].join("\n"));
    await chmod(fakeShell, 0o755);
    try {
      const result = await withShellPathEnvForTest(
        { SHELL: fakeShell, PATH: "/tmp/async-fallback" },
        async () => getShellPath()
      );
      assert.ok(
        result.startsWith("/tmp/async-fallback"),
        `expected fallback PATH prefix; got: ${result}`
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("concurrent calls in the same context share the in-flight promise", async () => {
    // The first getShellPath() sets cachedShellPathPromise synchronously before
    // its first await.  The second call (started before the first await) finds
    // cachedShellPathPromise !== null (line 139) and returns it directly, so
    // only one shell invocation occurs.
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-concurrent-")
    );
    const counterPath = path.join(tempDir, "counter");
    try {
      const env = {
        ...process.env,
        SHELL: await writeFakeShell(tempDir),
        CL_TEST_SHELL_PATH_OUTPUT: "/tmp/concurrent-test:/usr/bin",
        CL_TEST_SHELL_COUNTER: counterPath,
      };
      await withShellPathEnvForTest(env, async () => {
        const p1 = getShellPath();
        const p2 = getShellPath();
        const [result1, result2] = await Promise.all([p1, p2]);
        assert.equal(result1, "/tmp/concurrent-test:/usr/bin");
        assert.equal(result2, result1);
        assert.equal(await readFile(counterPath, "utf8"), "1");
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ISS-5299: configuredShell /bin/zsh default (line 63) and shellPathFallback
// PATH ?? "" empty-string fallback (line 67).
describe("configuredShell and shellPathFallback edge cases", () => {
  test("uses /bin/zsh when SHELL is absent from env", () => {
    // env without a SHELL key forces configuredShell to return "/bin/zsh"
    // (line 63).  /bin/zsh may or may not exist on the host; either way the
    // function must resolve to a non-empty, sentinel-free path string.
    const result = withShellPathEnvForTest({ PATH: "/tmp/no-shell-env" }, () =>
      getShellPathSync()
    );
    assert.ok(result.length > 0, `expected non-empty result; got: "${result}"`);
    assert.ok(!result.includes("__CLPATH_START__"), result);
  });

  test("shellPathFallback uses empty string when env has no PATH key", async () => {
    // env has SHELL but no PATH key → env.PATH ?? "" fires (line 67).
    // The always-failing shell forces both variants to catch, reaching fallback.
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-no-path-")
    );
    const fakeShell = path.join(tempDir, "always-fail-shell");
    await writeFile(fakeShell, ["#!/bin/sh", "exit 1", ""].join("\n"));
    await chmod(fakeShell, 0o755);
    try {
      const result = withShellPathEnvForTest({ SHELL: fakeShell }, () =>
        getShellPathSync()
      );
      // shellPathFallback(`${undefined ?? ""}:...`) → ":/opt/homebrew/bin:..."
      assert.ok(result.startsWith(":"), result);
      assert.ok(result.includes("/opt/homebrew/bin"), result);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ISS-5299: global cache reset path in resetActiveShellPathCache (line 258)
// and process.env.PATH fallback in setShellPathForTest (line 293).
describe("shell path cache control outside test context", () => {
  test("resetShellPathCacheOnlyForTest clears global cache when no test context is active", () => {
    // afterEach cleared the context, so activeTestContext() returns null here.
    // resetShellPathCacheOnlyForTest → resetActiveShellPathCache → testContext is
    // null → executes global-reset branch (line 258: cachedShellPath = null).
    // After the reset the module must still resolve a path correctly.
    resetShellPathCacheOnlyForTest();
    const result = getShellPathSync();
    assert.ok(typeof result === "string" && result.length > 0);
    assert.ok(!result.includes("__CLPATH_START__"), result);
  });

  test("setShellPathForTest falls back to process.env.PATH when env has no PATH key", () => {
    // env without PATH key makes testContext?.env?.PATH undefined, hitting the
    // ?? process.env.PATH fallback on line 293.
    const result = withShellPathEnvForTest({ SHELL: "/bin/sh" }, () => {
      setShellPathForTest();
      return getShellPathSync();
    });
    const expectedPath = process.env.PATH ?? "";
    assert.equal(result, expectedPath);
  });
});

// ISS-5299: _setKnownBinaryLocationsForResolverTest override used instead of
// KNOWN_BINARY_LOCATIONS (line 478), binary absent from override returns []
// (line 479), and resolveFromKnownLocationsSync catch for a missing path
// (line 508).
describe("_setKnownBinaryLocationsForResolverTest override", () => {
  test("override replaces KNOWN_BINARY_LOCATIONS for known-location resolution", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-known-loc-")
    );
    const fakeBin = path.join(tempDir, "claude");
    await writeFile(fakeBin, "#!/bin/sh\necho hello\n");
    await chmod(fakeBin, 0o755);
    try {
      _setKnownBinaryLocationsForResolverTest({ claude: [fakeBin] });
      const result = withShellPathEnvForTest(
        { PATH: "/nonexistent-bin-dir", SHELL: "/bin/sh" },
        () => {
          setShellPathForTest();
          return resolveBinaryFromLoginShellSync("claude");
        }
      );
      assert.equal(result.path, fakeBin);
      assert.equal(result.source, "known_location");
    } finally {
      _setKnownBinaryLocationsForResolverTest(null);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns fallback source when binary is absent from the override", () => {
    // Empty override → source["claude"] is undefined → ?? [] returns [] (line 479).
    // No known-location hit → resolveBinaryFromLoginShellSync falls through to fallback.
    try {
      _setKnownBinaryLocationsForResolverTest({});
      const result = withShellPathEnvForTest(
        { PATH: "/nonexistent-bin-dir", SHELL: "/bin/sh" },
        () => {
          setShellPathForTest();
          return resolveBinaryFromLoginShellSync("claude");
        }
      );
      assert.equal(result.source, "fallback");
    } finally {
      _setKnownBinaryLocationsForResolverTest(null);
    }
  });

  test("resolveFromKnownLocationsSync skips non-existent paths before returning an executable hit", async () => {
    // The first entry does not exist → accessSync throws → catch fires (line 508).
    // The second entry is a real executable → returned as the result.
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "shell-path-known-skip-")
    );
    const nonExistentPath = path.join(tempDir, "not-here", "claude");
    const executableBin = path.join(tempDir, "claude");
    await writeFile(executableBin, "#!/bin/sh\necho hello\n");
    await chmod(executableBin, 0o755);
    try {
      _setKnownBinaryLocationsForResolverTest({
        claude: [nonExistentPath, executableBin],
      });
      const result = withShellPathEnvForTest(
        { PATH: "/nonexistent-bin-dir", SHELL: "/bin/sh" },
        () => {
          setShellPathForTest();
          return resolveBinaryFromLoginShellSync("claude");
        }
      );
      assert.equal(result.path, executableBin);
      assert.equal(result.source, "known_location");
    } finally {
      _setKnownBinaryLocationsForResolverTest(null);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
