/**
 * ISS-8326 — `test:node` must refuse to start in a tree where `build:prereqs`
 * has not run, and must say so in one sentence.
 *
 * WHAT THE OLD BEHAVIOUR ACTUALLY WAS, measured on a fresh worktree of `main` at
 * 8c9f34bd5 before this gate existed: `vitest list --config
 * vitest.node.config.ts` reported 213 of the 1338 files unable to resolve an
 * import, as 587 `ERR_MODULE_NOT_FOUND` frames, and exited 1. So the RUN was
 * red — Vitest 4.1.8 fails a collect error, and separately fails a file that
 * registers no test ("No test suite found in file"); both were verified rather
 * than assumed. What was not legible was the CAUSE: the default reporter renders
 * each broken file as `❯ test/foo.test.ts (0 test)`, and a wall of those reads
 * like a suite with nothing in it rather than a tree that was never prepared.
 *
 * THE GATE COVERS BOTH HALVES OF `build:prereqs`, and the review that got it
 * there is the reason several cases below exist. Its first version checked four
 * in-package modules, which left two ways to pass while the failure still
 * happened: `prisma generate` writes FOUR modules and only `client.ts` was
 * named, and `pnpm --filter desktop test` runs `test:preflight`, which runs
 * `prebuild` and `db:generate` but NOT `build:deps` — so on the most common
 * invocation every sentinel existed and `test:node` died in the collect errors
 * anyway. Both are executed here as counterfactuals: withhold one artifact at a
 * time and the gate must go red for it.
 *
 * The decision is executed in BOTH directions against synthetic trees, and the
 * production entrypoint is spawned for real — a wiring test that only asserted
 * the script exists would stay green with the gate dropped from the manifest.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "vitest";

import {
  allPrerequisites,
  dependencyBuildPrerequisites,
  GENERATED_PREREQUISITES,
  missingPrerequisites,
  prerequisiteProblem,
} from "../scripts/assert-test-prereqs-lib.mjs";
import { GENERATED_CLIENT_OUTPUTS } from "../scripts/generate-prisma-client-lib.mjs";

// cwd for the desktop test suite is apps/desktop.
const DESKTOP_DIR = path.resolve(".");
const REPO_ROOT = path.resolve("..", "..");
const ENTRYPOINT = path.join(DESKTOP_DIR, "scripts", "assert-test-prereqs.mjs");
const MANIFEST = path.join(DESKTOP_DIR, "package.json");

/** The gate's own prefix, so a failure is attributable to it and not to Node. */
const GATE_PREFIX = /^\[assert-test-prereqs]/m;
const REMEDY = /pnpm --filter desktop run build:prereqs/;
/** The refusal must say `test:preflight` alone does not prepare the tree. */
const PREFLIGHT_IS_NOT_ENOUGH = /test:preflight/;
/** `build:deps` is what produces a dependency's build output. */
const BUILD_DEPS = /build:deps/;
/** Every derived dependency sentinel is a build-output directory. */
const BUILD_OUTPUT_DIR = /\/dist$/;
/**
 * `scripts/lint/node-test-lane-coverage.ts`'s `LOCAL_RUNNER`, which decides
 * which runner a lane executes from the FIRST `node <file>` in its script body.
 * Copied deliberately: this file asserts a property OF that guard's input, and
 * importing across the app boundary to get it would put a `scripts/` module in
 * apps/desktop's TypeScript program.
 */
const FIRST_LOCAL_RUNNER =
  /\b(?:node|tsx)\s+((?:\.\/)?[\w./-]+\.(?:mjs|cjs|js|ts))\b/;
const CHILD_TIMEOUT_MS = 30_000;

type DesktopScripts = { scripts?: Record<string, string> };
type Manifest = Record<string, unknown>;

/** A desktop manifest with no workspace dependencies, so the dependency half of
 * the gate contributes nothing and the in-package half can be tested alone. */
const NO_WORKSPACE_DEPS: Manifest = { name: "desktop" };

/**
 * A synthetic repository whose `apps/desktop` manifest is `desktopManifest`,
 * whose workspace members are `members`, and which contains exactly `present`.
 *
 * Returns the repo root; the gate takes `apps/desktop` and walks up to it.
 */
function syntheticRepo(options: {
  present?: readonly string[];
  desktopManifest?: Manifest;
  members?: Readonly<Record<string, Manifest>>;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), "assert-test-prereqs-"));
  writeManifest(
    root,
    "apps/desktop",
    options.desktopManifest ?? NO_WORKSPACE_DEPS
  );
  for (const [directory, manifest] of Object.entries(options.members ?? {})) {
    writeManifest(root, directory, manifest);
  }
  for (const entry of options.present ?? []) {
    const absolute = path.join(root, ...entry.split("/"));
    // A build output is a DIRECTORY and a generated module is a FILE; the gate
    // only asks whether the path exists, but the stand-in should still be the
    // shape the real artifact is.
    if (path.extname(entry) === "") {
      mkdirSync(absolute, { recursive: true });
    } else {
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, "// generated\n");
    }
  }
  return root;
}

function writeManifest(root: string, directory: string, manifest: Manifest) {
  const absolute = path.join(root, ...directory.split("/"));
  mkdirSync(absolute, { recursive: true });
  writeFileSync(
    path.join(absolute, "package.json"),
    `${JSON.stringify(manifest)}\n`
  );
}

function desktopDirOf(repoRoot: string): string {
  return path.join(repoRoot, "apps", "desktop");
}

function runEntrypoint(desktopDir: string) {
  return spawnSync(process.execPath, [ENTRYPOINT, desktopDir], {
    encoding: "utf8",
    // A deadline on the CHILD: node:test's own timeout is a timer on this
    // worker's event loop, which `spawnSync` blocks until the child exits.
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function desktopScripts(): Record<string, string> {
  return (
    (JSON.parse(readFileSync(MANIFEST, "utf8")) as DesktopScripts).scripts ?? {}
  );
}

describe("the test:node prerequisite gate", () => {
  test("an unprepared tree is reported, naming every missing module", () => {
    const root = syntheticRepo({});
    try {
      assert.deepEqual(
        missingPrerequisites(desktopDirOf(root)).map((entry) => entry.file),
        GENERATED_PREREQUISITES.map((entry) => entry.file)
      );

      const problem = prerequisiteProblem(desktopDirOf(root)) ?? "";
      assert.match(problem, GATE_PREFIX);
      assert.match(problem, REMEDY);
      for (const entry of GENERATED_PREREQUISITES) {
        assert.ok(
          problem.includes(entry.file),
          `the refusal must name ${entry.file}; a count alone does not say what to look at`
        );
        assert.ok(
          problem.includes(entry.producedBy),
          `the refusal must name what produces ${entry.file}`
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a prepared tree is allowed through", () => {
    // The opposite branch, or the gate could refuse unconditionally and every
    // assertion above would still pass while `test:node` never ran again.
    const root = syntheticRepo({
      present: GENERATED_PREREQUISITES.map((entry) => entry.file),
    });
    try {
      assert.deepEqual(missingPrerequisites(desktopDirOf(root)), []);
      assert.equal(prerequisiteProblem(desktopDirOf(root)), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ONE missing module is enough to refuse", () => {
    // Every entry, one at a time: a gate that only fired on a wholly empty tree
    // would miss the common case — `prebuild` ran, `db:generate` did not.
    for (const withheld of GENERATED_PREREQUISITES) {
      const root = syntheticRepo({
        present: GENERATED_PREREQUISITES.filter(
          (entry) => entry !== withheld
        ).map((entry) => entry.file),
      });
      try {
        assert.deepEqual(
          missingPrerequisites(desktopDirOf(root)).map((entry) => entry.file),
          [withheld.file]
        );
        assert.match(
          prerequisiteProblem(desktopDirOf(root)) ?? "",
          GATE_PREFIX
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("every module `prisma generate` writes is a sentinel, not just the first", () => {
    // The review case. `client.ts` alone let a generation interrupted between
    // outputs — or a hand-deleted `internal/` — satisfy the gate and then die in
    // the collect errors it exists to replace. The list is IMPORTED from the
    // generator that produces it, so a fifth output is covered the day it is
    // added rather than the day someone remembers this file.
    const generated = GENERATED_PREREQUISITES.filter((entry) =>
      entry.producedBy.startsWith("db:generate")
    ).map((entry) => entry.file);
    assert.deepEqual(
      generated,
      GENERATED_CLIENT_OUTPUTS.map(
        (output) => `apps/desktop/src/main/database/generated/${output}`
      )
    );
    assert.ok(
      generated.length > 1,
      "one output is the bug this case was written for"
    );
  });

  test("a dependency that resolves through a build directory is a sentinel", () => {
    // Derived from the dependency's OWN resolution contract, never hardcoded:
    // a wrong guess at a built entry point fails every lane in CI, which is why
    // the first version of this gate declined to check this half at all.
    const root = syntheticRepo({
      desktopManifest: {
        name: "desktop",
        dependencies: {
          "@scope/built": "workspace:*",
          "@scope/from-source": "workspace:*",
          "@scope/not-a-workspace-dep": "^1.0.0",
        },
      },
      members: {
        "packages/built": {
          name: "@scope/built",
          exports: { "./thing": { import: "./dist/thing.js" } },
        },
        "packages/from-source": {
          name: "@scope/from-source",
          exports: { "./*": { default: "./src/*.ts" } },
        },
        "packages/not-a-workspace-dep": {
          name: "@scope/not-a-workspace-dep",
          main: "./dist/index.js",
        },
      },
    });
    try {
      assert.deepEqual(
        dependencyBuildPrerequisites(root).map((entry) => entry.file),
        ["packages/built/dist"],
        "only a workspace dependency that resolves an import through a build directory earns an entry"
      );
      assert.match(
        dependencyBuildPrerequisites(root)[0]?.producedBy ?? "",
        BUILD_DEPS,
        "the refusal must name the script that produces it"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a workspace dependency with no member package earns no entry", () => {
    const root = syntheticRepo({
      desktopManifest: {
        name: "desktop",
        dependencies: {
          "@scope/built": "workspace:*",
          "@scope/missing": "workspace:*",
        },
      },
      members: {
        "packages/built": { name: "@scope/built", main: "./dist/index.js" },
      },
    });
    try {
      assert.deepEqual(
        dependencyBuildPrerequisites(root).map((entry) => entry.file),
        ["packages/built/dist"]
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree prepared by `test:preflight` alone is still refused", () => {
    // THE REGRESSION. `pnpm --filter desktop test` runs `test:preflight`, which
    // runs `prebuild` and `db:generate` but NOT `build:deps`. Every in-package
    // sentinel therefore exists while the workspace `dist/` output does not, and
    // before this case the gate passed and `test:node` died in the same
    // `ERR_MODULE_NOT_FOUND` wall — a gate that passes while the defect it
    // exists to prevent occurs.
    const root = syntheticRepo({
      present: GENERATED_PREREQUISITES.map((entry) => entry.file),
      desktopManifest: {
        name: "desktop",
        dependencies: { "@scope/built": "workspace:*" },
      },
      members: {
        "packages/built": {
          name: "@scope/built",
          exports: { "./thing": { import: "./dist/thing.js" } },
        },
      },
    });
    try {
      assert.deepEqual(
        missingPrerequisites(desktopDirOf(root)).map((entry) => entry.file),
        ["packages/built/dist"],
        "`test:preflight` leaves the dependency build output absent; the gate must say so"
      );
      const problem = prerequisiteProblem(desktopDirOf(root)) ?? "";
      assert.match(problem, GATE_PREFIX);
      assert.match(
        problem,
        PREFLIGHT_IS_NOT_ENOUGH,
        "the remedy must say `test:preflight` is not enough, since that is what the caller just ran"
      );

      // And the opposite branch, so this cannot pass by refusing everything.
      mkdirSync(path.join(root, "packages", "built", "dist"), {
        recursive: true,
      });
      assert.equal(prerequisiteProblem(desktopDirOf(root)), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the entrypoint exits non-zero on an unprepared tree", () => {
    const root = syntheticRepo({});
    try {
      const result = runEntrypoint(desktopDirOf(root));
      assert.equal(
        result.error,
        undefined,
        `the gate did not exit on its own: ${result.error?.message ?? ""}`
      );
      assert.notEqual(
        result.status,
        0,
        "an unprepared tree must fail here, before ~200 anonymous collect errors"
      );
      assert.match(result.stderr, GATE_PREFIX);
      assert.match(result.stderr, REMEDY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the entrypoint exits zero on a prepared tree", () => {
    const root = syntheticRepo({
      present: GENERATED_PREREQUISITES.map((entry) => entry.file),
    });
    try {
      const result = runEntrypoint(desktopDirOf(root));
      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        0,
        `the gate must not block a prepared tree: ${result.stderr}`
      );
      assert.equal(result.stderr, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the tree this suite is running in satisfies the gate", () => {
    // The in-package list is hand-written and the dependency list is derived, so
    // either could name a path nothing produces — a gate that fails every lane.
    // This case can only pass in a tree where `build:prereqs` really ran, which
    // is every lane that runs this file.
    assert.deepEqual(
      missingPrerequisites(DESKTOP_DIR).map((entry) => entry.file),
      []
    );
  });

  test("the real tree's dependency half is non-empty and really is built output", () => {
    // A derivation that quietly resolved to nothing would make the case above
    // pass vacuously, which is exactly how the first version of this gate looked
    // complete while the `build:deps` half went unchecked.
    const derived = dependencyBuildPrerequisites(REPO_ROOT);
    assert.ok(
      derived.length > 0,
      "no workspace dependency resolves through a build directory; the derivation has stopped seeing them"
    );
    const combined = allPrerequisites(REPO_ROOT).map((entry) => entry.file);
    for (const entry of derived) {
      assert.match(entry.file, BUILD_OUTPUT_DIR);
      assert.ok(
        combined.includes(entry.file),
        `${entry.file} is derived but never reaches the gate's own list`
      );
    }
  });

  test("every sentinel is gitignored, so none is satisfied by a committed file", () => {
    // The list may only name artifacts a BUILD produces. A committed file on it
    // is an assertion that is always true, which is a gate that cannot fail.
    const files = allPrerequisites(REPO_ROOT).map((entry) => entry.file);
    const ignored = spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: REPO_ROOT,
      input: `${files.join("\n")}\n`,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    assert.equal(ignored.error, undefined);
    const reported = new Set(ignored.stdout.split("\n").filter(Boolean));
    for (const file of files) {
      assert.ok(
        reported.has(file),
        `${file} is not gitignored, so its presence says nothing about whether build:prereqs ran`
      );
    }
  });

  test("`test:node` actually runs the gate, before the runner", () => {
    // Without this the gate is a script nobody invokes. Read from the manifest
    // rather than asserted as a literal elsewhere: the manifest IS the wiring.
    const scripts = desktopScripts();
    assert.ok(
      (scripts["assert:test-prereqs"] ?? "").includes(
        "scripts/assert-test-prereqs.mjs"
      ),
      "the `assert:test-prereqs` script must run this gate"
    );

    const lane = scripts["test:node"] ?? "";
    const gateAt = lane.indexOf("assert:test-prereqs");
    const runnerAt = lane.indexOf("run-node-tests.mjs");
    assert.ok(gateAt >= 0, "`test:node` must run the prerequisite gate");
    assert.ok(runnerAt >= 0, "`test:node` must still run the suite");
    assert.ok(
      gateAt < runnerAt,
      "the gate must come first, or it reports after the wall of collect errors it exists to replace"
    );
  });

  test("the runner stays the first local runner named on the lane", () => {
    // `scripts/lint/node-test-lane-coverage.ts` reads the FIRST `node <file>` in
    // a script body to decide which runner a lane executes. Invoking the gate as
    // `pnpm assert:test-prereqs` keeps that first match on `run-node-tests.mjs`;
    // spelling it `node scripts/assert-test-prereqs.mjs` instead would drop the
    // 1338-file Vitest lane out of both lane registers without failing anything
    // else — a discovery hole that reads exactly like coverage.
    assert.equal(
      FIRST_LOCAL_RUNNER.exec(desktopScripts()["test:node"] ?? "")?.[1],
      "scripts/run-node-tests.mjs"
    );
  });
});
