/**
 * ISS-12135: a harness launch on a missing or unloadable Desktop build fails
 * as a test error before Electron starts, and a Desktop launch stays off screen
 * unless it opted into a window.
 *
 * The bundle cases run the real child-process resolver against synthetic
 * trees, because the lane has no Desktop build and the resolver is what decides.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import { assertMainBundleLaunchable } from "../scripts/main-bundle-launch-preflight-lib.mjs";
import {
  E2E_NO_REVEAL_ARG,
  isWindowRevealSuppressed,
} from "../src/main/lifecycle/window-reveal-suppression.js";
import {
  HARNESS_LAUNCH_FAILURE_MARKER,
  launchElectronOrExplain,
} from "./e2e/helpers/electron-launch-attribution.js";
import {
  E2E_REVEAL_WINDOW_OPT_IN_ARG,
  preflightElectronLaunch,
} from "./e2e/helpers/electron-launch-preflight.js";

/** The 2026-10-20 incident's specifier: a package subpath with no `exports`. */
const UNEXPORTED_SUBPATH = "@fixture/no-exports/shared/lib/feature-flags";
const NO_APP_ENTRY = /no app entry/;
/** Shaped like @closedloop-ai/design-system: its `main` is TypeScript source. */
const TYPESCRIPT_MAIN_PACKAGE = "@fixture/typescript-main";
/** `NESTED_COMMAND_RE` from `src/main/collectors/evidence/test-invocation.ts`. */
const REGEX_WITH_BACKTICK = "const NESTED_COMMAND_RE = /\\$\\(|[<>]\\(|`/;";
const USER_DATA_ARG = "--user-data-dir=/tmp/preflight-profile";
/** Each case spawns a plain `node` child that parses the fixture bundle. */
const RESOLVER_CASE_TIMEOUT_MS = 30_000;

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("main bundle preflight (ISS-12135)", () => {
  test("a missing entry is refused by name", () => {
    const entry = path.join(newFixtureRoot(), "dist/main/index.js");

    assert.throws(
      () => assertMainBundleLaunchable(entry),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(entry) &&
        error.message.includes("does not exist")
    );
  });

  test("a chunk importing a package subpath that does not exist is refused", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    const entry = bundleFixture({
      "index.js": `import("./startup-abc.js");`,
      "startup-abc.js": `import { KEY } from "${UNEXPORTED_SUBPATH}";\nexport { KEY };`,
    });

    assert.throws(
      () => assertMainBundleLaunchable(entry),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("startup-abc.js") &&
        error.message.includes(UNEXPORTED_SUBPATH)
    );
  });

  test("a chunk the entry imports but the build did not write is refused", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    const entry = bundleFixture({
      "index.js": `import "./startup-gone.js";`,
    });

    assert.throws(
      () => assertMainBundleLaunchable(entry),
      (error: unknown) =>
        error instanceof Error && error.message.includes("./startup-gone.js")
    );
  });

  test("a package whose main is TypeScript source is refused", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    // Shaped like @closedloop-ai/design-system: `"main": "./index.tsx"`, no `exports`.
    // The specifier resolves to a file that exists, and Node still cannot load it.
    const entry = bundleFixture({
      "index.js": `import "${TYPESCRIPT_MAIN_PACKAGE}";`,
    });

    assert.throws(
      () => assertMainBundleLaunchable(entry),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(TYPESCRIPT_MAIN_PACKAGE) &&
        error.message.includes("TypeScript source")
    );
  });

  test("a backtick inside a regex literal does not turn a comment into an import", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    // The shape of the real skill-shadow-inventory chunk: NESTED_COMMAND_RE,
    // then a doc comment with backticks. A token scanner reads the regex's
    // backtick as a template start, flips at each backtick after it, and reports
    // the commented import as real, refusing a good build.
    const entry = bundleFixture({
      "index.js": [
        REGEX_WITH_BACKTICK,
        "/**",
        " * A `x` example, then",
        ' * heredoc writing `import { vi } from "@fixture/not-installed"` here.',
        " */",
        "export const ok = true;",
      ].join("\n"),
    });

    assert.doesNotThrow(() => assertMainBundleLaunchable(entry));
  });

  test("an import after a backtick regex literal is still checked", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    // The other half of losing sync: a real import swallowed by the scanner.
    const entry = bundleFixture({
      "index.js": [
        REGEX_WITH_BACKTICK,
        `export { KEY } from "${UNEXPORTED_SUBPATH}";`,
      ].join("\n"),
    });

    assert.throws(
      () => assertMainBundleLaunchable(entry),
      (error: unknown) =>
        error instanceof Error && error.message.includes(UNEXPORTED_SUBPATH)
    );
  });

  test("a package that is not installed is refused", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    const entry = bundleFixture({
      "index.js": `import "@fixture/not-installed";`,
    });

    assert.throws(
      () => assertMainBundleLaunchable(entry),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("@fixture/not-installed")
    );
  });

  test("a bundle whose every import resolves is accepted", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    // Positive control for the refusals above, with each specifier kind the
    // real bundle uses: Electron's own module (provided at runtime, absent from
    // node_modules here), a builtin, a package main, and an exact subpath.
    const entry = bundleFixture({
      "index.js": [
        `import { app } from "electron";`,
        `import fs from "node:fs";`,
        `import "@fixture/has-main";`,
        `import "@fixture/no-exports/shared/lib/real.js";`,
        `import("./startup-ok.js");`,
      ].join("\n"),
      "startup-ok.js": "export const ok = true;",
    });

    assert.doesNotThrow(() => assertMainBundleLaunchable(entry));
  });
});

describe("harness launch preflight (ISS-12135)", () => {
  test("a missing entry never reaches the launcher, and names its cause", async () => {
    let launches = 0;
    const entry = path.join(newFixtureRoot(), "missing/index.js");

    const failure = await launchElectronOrExplain({ args: [entry] }, () => {
      launches += 1;
      return Promise.resolve("launched");
    }).then(
      () => null,
      (error: unknown) => error
    );

    assert.ok(failure instanceof Error);
    assert.equal(launches, 0);
    assert.ok(failure.message.includes(entry));
    // The cause is known, so it is not reported as the cause-free launch death.
    assert.ok(!failure.message.includes(HARNESS_LAUNCH_FAILURE_MARKER));
  });

  test("args with no app entry are refused rather than opening Electron's default app", () => {
    assert.throws(
      () => preflightElectronLaunch({ args: ["-r", "preload.cjs"] }),
      NO_APP_ENTRY
    );
  });

  test("a Desktop launch that states no window choice is put off screen", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    const entry = loadableBundleFixture();

    const prepared = preflightElectronLaunch(
      { args: ["-r", "preload.cjs", entry, USER_DATA_ARG] },
      entry
    );

    assert.deepEqual(prepared.args, [
      "-r",
      "preload.cjs",
      entry,
      USER_DATA_ARG,
      E2E_NO_REVEAL_ARG,
    ]);
  });

  test("an explicit choice either way is left as stated", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    const entry = loadableBundleFixture();

    for (const choice of [E2E_NO_REVEAL_ARG, E2E_REVEAL_WINDOW_OPT_IN_ARG]) {
      assert.deepEqual(
        preflightElectronLaunch({ args: [entry, choice] }, entry).args,
        [entry, choice]
      );
    }
  });

  test("an unloadable Desktop bundle is refused before the window choice is made", {
    timeout: RESOLVER_CASE_TIMEOUT_MS,
  }, () => {
    const entry = bundleFixture({
      "index.js": `import "${UNEXPORTED_SUBPATH}";`,
    });

    assert.throws(
      () => preflightElectronLaunch({ args: [entry] }, entry),
      (error: unknown) =>
        error instanceof Error && error.message.includes(UNEXPORTED_SUBPATH)
    );
  });

  test("the reveal opt-in is not itself read as suppression by the app", () => {
    // The opt-in only declares intent to the preflight. If the app matched it as
    // its suppression switch, a deliberate reveal would stay off screen.
    assert.equal(
      isWindowRevealSuppressed([E2E_REVEAL_WINDOW_OPT_IN_ARG], {
        isPackaged: false,
      }),
      false
    );
  });
});

function newFixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-launch-preflight-"));
  fixtureRoots.push(root);
  return root;
}

/**
 * A `dist/main` tree beside a `node_modules` holding: a package with a `main`,
 * one whose `main` is TypeScript source, one with no `exports` map (whose
 * subpaths resolve only when exact), and none named `not-installed`.
 */
function bundleFixture(chunks: Record<string, string>): string {
  const root = newFixtureRoot();
  const mainDir = path.join(root, "dist/main");
  mkdirSync(mainDir, { recursive: true });
  for (const [name, text] of Object.entries(chunks)) {
    writeFileSync(path.join(mainDir, name), text);
  }
  writePackage(root, "@fixture/has-main", { main: "index.js" }, ["index.js"]);
  writePackage(root, TYPESCRIPT_MAIN_PACKAGE, { main: "./index.tsx" }, [
    "index.tsx",
  ]);
  writePackage(root, "@fixture/no-exports", {}, [
    "shared/lib/real.js",
    "shared/lib/feature-flags.ts",
  ]);
  return path.join(mainDir, "index.js");
}

function loadableBundleFixture(): string {
  return bundleFixture({ "index.js": `import fs from "node:fs";` });
}

function writePackage(
  root: string,
  name: string,
  fields: Record<string, string>,
  files: readonly string[]
): void {
  const dir = path.join(root, "node_modules", name);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), "export {};");
  }
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, type: "module", ...fields })
  );
}
