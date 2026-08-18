/**
 * ISS-5303 — `write-build-info-lib.mjs`, the decision-making half of the
 * `prebuild` step that emits `src/shared/build-info.ts`.
 *
 * Two things are worth pinning here. The RENDER, because `BUILD_APP_VERSION` is
 * the authoritative `service.version` for desktop telemetry (FEA-2199) and a
 * malformed or `"undefined"` value poisons the fleet's version facet. And the
 * CONTENT-AWARE WRITE, because `pnpm prebuild` runs on every local launch: an
 * unconditional write would bump the mtime of a file both the main process and
 * the renderer import, invalidating incremental builds on every single launch.
 *
 * The final case drives `write-build-info.mjs` itself as a subprocess, so
 * rewiring the shell to render its own template, or dropping the
 * write-if-changed call, fails here rather than silently churning mtimes again.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BuildInfoWriteOutcome,
  renderBuildInfoSource,
  resolveAppVersion,
  writeBuildInfoIfChanged,
} from "../scripts/write-build-info-lib.mjs";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(DESKTOP_DIR, "scripts", "write-build-info.mjs");
const GENERATED_FILE = join(DESKTOP_DIR, "src", "shared", "build-info.ts");
const DISPLAY_PATH = "src/shared/build-info.ts";
const UNCHANGED_MESSAGE = "write-build-info: unchanged\n";
const WROTE_MESSAGE = `write-build-info: wrote ${DISPLAY_PATH}\n`;

/**
 * The entrypoint reads package.json, shells out to `git rev-parse` and writes
 * one small file; anything approaching this is a hang, not a slow machine.
 * node:test's own `timeout` cannot interrupt `spawnSync` (it blocks this
 * worker's event loop), so the children need their own deadline — the
 * `test:node` slice gates the required `desktop` check and has no retry.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 120_000;

/**
 * Run a child to completion, refusing anything that did not exit on its own.
 * `spawnSync` reports both a launch failure and a `timeout` kill on `.error`
 * rather than throwing, so this is where a deadlined child becomes a clear
 * failure instead of an empty stdout mismatching a later assertion.
 */
function runToCompletion(
  command: string,
  args: readonly string[],
  label: string
): string {
  const result = spawnSync(command, [...args], {
    cwd: DESKTOP_DIR,
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error) {
    throw new Error(
      `${label} did not exit on its own: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

// A pinned instant in the past (2020-09-13T12:26:40Z). Comparing a stat against
// this fixed value — rather than against "now" — keeps the no-churn assertion
// off the wall clock and immune to coarse filesystem mtime granularity.
const PINNED_MTIME_SECONDS = 1_600_000_000;

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "write-build-info-lib-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ISS-5303: build-info source render", () => {
  test("emits the generated header and both build constants", () => {
    assert.equal(
      renderBuildInfoSource({
        commitHash: "34dfd645e5b5005755deb1f302d511bf70a818a1",
        appVersion: "0.16.69",
      }),
      `// AUTO-GENERATED — do not edit
export const BUILD_COMMIT_HASH = "34dfd645e5b5005755deb1f302d511bf70a818a1";
export const BUILD_APP_VERSION = "0.16.69";
`
    );
  });

  test("takes a string version straight from the parsed package.json", () => {
    assert.equal(resolveAppVersion({ version: "0.16.69" }), "0.16.69");
  });

  test("degrades a missing or non-string version to an empty string", () => {
    // Never `"undefined"`. This value is baked into telemetry as
    // `service.version`; a plausible-but-wrong string is worse than an empty
    // one, which reads as "unset" downstream.
    assert.equal(resolveAppVersion({}), "");
    assert.equal(resolveAppVersion({ version: 16 }), "");
    assert.equal(resolveAppVersion(null), "");
    assert.equal(resolveAppVersion("0.16.69"), "");
  });
});

describe("ISS-5303: build-info is written only when its bytes change", () => {
  test("writes when the output file does not exist yet", () => {
    withTempDir((dir) => {
      const outFile = join(dir, "build-info.ts");
      const contents = renderBuildInfoSource({
        commitHash: "aaaa1111",
        appVersion: "1.0.0",
      });

      const result = writeBuildInfoIfChanged({
        outFile,
        contents,
        displayPath: DISPLAY_PATH,
      });

      assert.equal(result.outcome, BuildInfoWriteOutcome.Wrote);
      assert.equal(result.message, WROTE_MESSAGE);
      assert.equal(readFileSync(outFile, "utf8"), contents);
    });
  });

  test("overwrites when the existing file differs", () => {
    withTempDir((dir) => {
      const outFile = join(dir, "build-info.ts");
      writeFileSync(
        outFile,
        renderBuildInfoSource({
          commitHash: "stale000",
          appVersion: "0.9.0",
        }),
        "utf8"
      );
      const contents = renderBuildInfoSource({
        commitHash: "fresh111",
        appVersion: "1.0.0",
      });

      const result = writeBuildInfoIfChanged({
        outFile,
        contents,
        displayPath: DISPLAY_PATH,
      });

      assert.equal(result.outcome, BuildInfoWriteOutcome.Wrote);
      assert.equal(result.message, WROTE_MESSAGE);
      assert.equal(readFileSync(outFile, "utf8"), contents);
    });
  });

  test("leaves the file completely untouched when the bytes match", () => {
    withTempDir((dir) => {
      const outFile = join(dir, "build-info.ts");
      const contents = renderBuildInfoSource({
        commitHash: "aaaa1111",
        appVersion: "1.0.0",
      });
      writeFileSync(outFile, contents, "utf8");
      utimesSync(outFile, PINNED_MTIME_SECONDS, PINNED_MTIME_SECONDS);
      const mtimeBefore = statSync(outFile).mtimeMs;

      const result = writeBuildInfoIfChanged({
        outFile,
        contents,
        displayPath: DISPLAY_PATH,
      });

      assert.equal(result.outcome, BuildInfoWriteOutcome.Unchanged);
      assert.equal(result.message, UNCHANGED_MESSAGE);
      // The whole point of the branch: an identical rewrite would still bump the
      // mtime and invalidate every incremental consumer of build-info.ts.
      assert.equal(
        statSync(outFile).mtimeMs,
        mtimeBefore,
        "an unchanged run must not touch the file's mtime"
      );
    });
  });

  test("a single differing byte is enough to trigger the write", () => {
    withTempDir((dir) => {
      const outFile = join(dir, "build-info.ts");
      const contents = renderBuildInfoSource({
        commitHash: "aaaa1111",
        appVersion: "1.0.0",
      });
      writeFileSync(outFile, `${contents} `, "utf8");

      const result = writeBuildInfoIfChanged({
        outFile,
        contents,
        displayPath: DISPLAY_PATH,
      });

      assert.equal(result.outcome, BuildInfoWriteOutcome.Wrote);
      assert.equal(readFileSync(outFile, "utf8"), contents);
    });
  });
});

describe("ISS-5303: write-build-info.mjs is wired to the lib", () => {
  test("the entrypoint renders through the lib and reports 'unchanged' on a repeat run", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    // `pnpm prebuild` runs this script on every launch, and its output is a
    // gitignored generated file, so driving the real entrypoint in place is
    // exactly what the build already does — no fixture tree can substitute,
    // because the paths, the `git rev-parse` and the package.json read all
    // live in the shell under test.
    //
    // The file is NOT deleted first to force the write branch: several `src/`
    // modules the parallel node suites import (persistent-log,
    // desktop-services, dev-update-commands) read it, so removing it mid-run
    // would break unrelated test files. The write branch is covered above,
    // against a fixture.
    //
    // Run once to normalize whatever state the tree is in...
    runToCompletion(process.execPath, [ENTRYPOINT], "write-build-info");
    // ...then assert the second run has nothing left to do. Dropping the
    // write-if-changed call would make this line say "wrote" instead.
    const second = runToCompletion(
      process.execPath,
      [ENTRYPOINT],
      "write-build-info"
    );

    assert.equal(second, UNCHANGED_MESSAGE);

    const commitHash = runToCompletion(
      "git",
      ["rev-parse", "HEAD"],
      "git rev-parse"
    ).trim();
    const appVersion = resolveAppVersion(
      JSON.parse(readFileSync(join(DESKTOP_DIR, "package.json"), "utf8"))
    );

    // Byte equality against the lib's own render: the shell must not carry a
    // second copy of the template, or the two drift the next time either
    // constant changes.
    assert.equal(
      readFileSync(GENERATED_FILE, "utf8"),
      renderBuildInfoSource({ commitHash, appVersion })
    );
  });
});
