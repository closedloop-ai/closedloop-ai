/**
 * ISS-12394 — branch coverage for `scripts/node-test-census.mjs`.
 *
 * Builds small fixture trees and runs the census over them, so each routing
 * rule (incompatible list, loader hook, disqualifying helper, node:test import,
 * excluded file) decides a real file. Also drives the AST helpers through the
 * import shapes the existing suites do not use.
 *
 * The calls run in a plain Node child, because the node lane's c8 only
 * credits code that runs outside a Vite-transformed worker.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runModuleInChild } from "./support/module-child";

const MODULE_URL = new URL("../scripts/node-test-census.mjs", import.meta.url)
  .href;
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
/** The default census parses the whole real `test/` tree. */
const SPAWN_TIMEOUT_MS = 120_000;
const CASE_TIMEOUT_MS = 2 * SPAWN_TIMEOUT_MS;
const VITEST_IMPORT = 'import { it } from "vitest";\n';
const NODE_TEST_IMPORT = 'import { it } from "node:test";\n';

type Census = { vitest: string[]; nodeTest: string[] };

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "node-test-census-iss12394-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function write(relative: string, source: string): void {
  const target = join(dir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function runInChild<T>(body: string): T {
  return runModuleInChild<T>({
    body,
    cwd: DESKTOP_DIR,
    moduleUrl: MODULE_URL,
    timeoutMs: SPAWN_TIMEOUT_MS,
  });
}

/** `m.<fn>(source, fileName, helpers?)` for each case, in one child. */
function classify(
  fn: "installsLoaderHook" | "isVitestEligible" | "importsVitest",
  cases: [string, string, string[]?][]
): boolean[] {
  return runInChild<boolean[]>(
    `out(${JSON.stringify(cases)}.map(([source, name, helpers]) => m.${fn}(source, name, helpers === undefined ? undefined : new Set(helpers))));`
  );
}

describe("installsLoaderHook import shapes", () => {
  it(
    "fires on an aliased hook import and on nothing else here",
    () => {
      expect(
        classify("installsLoaderHook", [
          ['import "node:module";', "h.ts"],
          ['import { registerHooks as hook } from "node:module";', "h.ts"],
          ['import { createRequire as register } from "node:module";', "h.ts"],
          ['const x = 1;\nimport { register } from "node:other";', "h.ts"],
        ])
      ).toEqual([false, true, false, false]);
    },
    CASE_TIMEOUT_MS
  );
});

describe("isVitestEligible rule order", () => {
  it(
    "rejects an incompatible name, a loader hook, and a listed helper; accepts the rest",
    () => {
      expect(
        classify("isVitestEligible", [
          [VITEST_IMPORT, "exception-sanitizer.test.ts"],
          [VITEST_IMPORT, "other.test.ts"],
          [
            `${VITEST_IMPORT}import { registerHooks } from "node:module";`,
            "sample.test.ts",
          ],
          [
            `const x = 1;\n${VITEST_IMPORT}import "./bad.js";`,
            "sample.test.ts",
            ["./bad.js"],
          ],
          [
            `const x = 1;\n${VITEST_IMPORT}import "./other.js";`,
            "sample.test.ts",
            ["./bad.js"],
          ],
          [NODE_TEST_IMPORT, "sample.test.ts", []],
        ])
      ).toEqual([false, true, false, false, true, false]);
    },
    CASE_TIMEOUT_MS
  );
});

describe("importsVitest", () => {
  it(
    "counts vitest, its subpaths, and a passed helper, but not a lookalike package",
    () => {
      const viaHelper = 'const x = 1;\nimport { h } from "./helper.js";';
      expect(
        classify("importsVitest", [
          ['import { defineConfig } from "vitest/config";', "a.ts"],
          [viaHelper, "a.test.ts"],
          [viaHelper, "a.test.ts", ["./helper.js"]],
          ['import x from "vitest-extra";', "a.ts"],
        ])
      ).toEqual([true, false, true, false]);
    },
    CASE_TIMEOUT_MS
  );
});

describe("censusTestFiles over a fixture tree", () => {
  it(
    "routes each file by the rule that decides it, sorted",
    () => {
      write("plain.test.ts", VITEST_IMPORT);
      write("legacy.test.ts", NODE_TEST_IMPORT);
      write(
        "hooked.test.ts",
        `${VITEST_IMPORT}import { register } from "node:module";`
      );
      write("exception-sanitizer.test.ts", VITEST_IMPORT);
      write("no-token-surface-dist.test.ts", VITEST_IMPORT);
      write("via-helper.test.ts", `${VITEST_IMPORT}import "./sub/bad.js";`);
      write("via-good-helper.test.ts", `${VITEST_IMPORT}import "./good.js";`);
      write("sub/bad.ts", NODE_TEST_IMPORT);
      write("good.ts", VITEST_IMPORT);
      write("notes.md", NODE_TEST_IMPORT);
      // A directory named like a test file is not collected.
      mkdirSync(join(dir, "dir.test.ts"));

      expect(
        runInChild<Census>(`out(m.censusTestFiles(${JSON.stringify(dir)}));`)
      ).toEqual({
        vitest: ["test/plain.test.ts", "test/via-good-helper.test.ts"],
        nodeTest: [
          "test/exception-sanitizer.test.ts",
          "test/hooked.test.ts",
          "test/legacy.test.ts",
          "test/via-helper.test.ts",
        ],
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    "disqualifies a test whose helper reaches node:test only through another helper",
    () => {
      write("chain.test.ts", `${VITEST_IMPORT}import "./a.js";`);
      write("a.ts", 'import "./b.js";');
      write("b.ts", NODE_TEST_IMPORT);

      expect(
        runInChild<Census>(`out(m.censusTestFiles(${JSON.stringify(dir)}));`)
      ).toEqual({ vitest: [], nodeTest: ["test/chain.test.ts"] });
    },
    CASE_TIMEOUT_MS
  );
});

describe("vitestReachingHelperSpecifiers over a fixture tree", () => {
  it(
    "is empty for a directory that does not exist",
    () => {
      expect(
        runInChild<string[]>(
          `out([...m.vitestReachingHelperSpecifiers(${JSON.stringify(join(dir, "missing"))})]);`
        )
      ).toEqual([]);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "collects helpers in nested directories and skips test files",
    () => {
      write("nested/deep/helper.ts", VITEST_IMPORT);
      write("nested/user.ts", 'import "./deep/helper.js";');
      write("unrelated.ts", 'import "./nested/none.js";');
      write("seed.test.ts", VITEST_IMPORT);

      expect(
        runInChild<string[]>(
          `out([...m.vitestReachingHelperSpecifiers(${JSON.stringify(dir)})].sort());`
        )
      ).toEqual(["./nested/deep/helper.js", "./nested/user.js"]);
    },
    CASE_TIMEOUT_MS
  );
});

describe("the default-directory memos", () => {
  it(
    "hand out copies, so a caller's mutation never reaches the next caller",
    () => {
      const result = runInChild<{
        vitestBefore: number;
        vitestAfter: number;
        injectedSurvived: boolean;
        helpersBefore: number;
        helpersAfter: number;
      }>(`
        const first = m.censusTestFiles();
        const vitestBefore = first.vitest.length;
        first.vitest.length = 0;
        first.nodeTest.push("test/injected.test.ts");
        const second = m.censusTestFiles(m.TEST_DIR);
        const helpers = m.vitestReachingHelperSpecifiers();
        const helpersBefore = helpers.size;
        helpers.add("./injected.js");
        out({
          vitestBefore,
          vitestAfter: second.vitest.length,
          injectedSurvived: second.nodeTest.includes("test/injected.test.ts"),
          helpersBefore,
          helpersAfter: m.vitestReachingHelperSpecifiers(m.TEST_DIR).size,
        });
      `);
      expect(result.vitestBefore).toBeGreaterThan(0);
      expect(result.vitestAfter).toBe(result.vitestBefore);
      expect(result.injectedSurvived).toBe(false);
      expect(result.helpersAfter).toBe(result.helpersBefore);
    },
    CASE_TIMEOUT_MS
  );
});
