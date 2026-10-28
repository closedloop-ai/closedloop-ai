// @ts-check

/**
 * ISS-8326 — refuse to start `test:node` in a tree whose generated modules do
 * not exist yet.
 *
 * `build:prereqs` (`build:deps` + `prebuild` + `db:generate`) writes the
 * gitignored modules and build output that the main-process suite imports
 * transitively. Run the suite without them and every lane that imports one dies
 * at COLLECTION:
 * measured on a fresh worktree of `main` at 8c9f34bd5, `vitest list --config
 * vitest.node.config.ts` reported 213 of the 1338 files unable to resolve an
 * import, as 587 `ERR_MODULE_NOT_FOUND` frames.
 *
 * That run is red — Vitest 4.1.8 exits 1 on a collect error and again on a file
 * that registers no test — so the verdict was never the problem. The READING was:
 * the default reporter renders each broken file as `❯ test/foo.test.ts (0 test)`,
 * and a wall of those "looks nothing like a red test" (ISS-8326). The remedy is
 * one sentence, so the runner should say it once, before the wall, instead of
 * leaving it to be inferred from 587 frames.
 *
 * Deliberately NOT a freshness check. A stale generated module is a different
 * failure with a different remedy, and the generators already fingerprint their
 * own inputs (`generate-prisma-client-lib.mjs`). This answers one question:
 * did `build:prereqs` run at all.
 *
 * BOTH HALVES OF `build:prereqs` ARE CHECKED, and the review that got it there
 * is worth keeping written down, because the first version checked one:
 *
 *   - `prebuild` + `db:generate` write gitignored modules INSIDE apps/desktop.
 *     Naming `client.ts` alone was not enough — `prisma generate` writes four
 *     modules, so a run interrupted between them satisfied the gate and failed
 *     at collection anyway. The list is now imported from the generator that
 *     produces it ({@link GENERATED_CLIENT_OUTPUTS}), so it cannot fall behind.
 *   - `build:deps` builds desktop's workspace dependency closure OUTSIDE
 *     apps/desktop, and a tree missing those `dist/` outputs fails the same
 *     anonymous way. `pnpm --filter desktop test` runs `test:preflight`, which
 *     runs `prebuild` and `db:generate` but NOT `build:deps` — so on the most
 *     common invocation every in-package sentinel exists and the gate passed
 *     while `test:node` still died in `ERR_MODULE_NOT_FOUND`.
 *
 * The `build:deps` half is DERIVED, never hardcoded, because a wrong guess at a
 * built entry point fails every lane in CI. {@link dependencyBuildPrerequisites}
 * reads each workspace dependency's OWN `exports`/`main` map and keeps only the
 * packages that resolve an import through a build directory. A package that
 * publishes source (`./src/*.ts`) contributes nothing, a package that starts
 * publishing `dist/` is covered the day it does, and the path checked is by
 * construction the one the importer resolves against.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { GENERATED_CLIENT_OUTPUTS } from "./generate-prisma-client-lib.mjs";

/** This package, relative to the repository root. */
const DESKTOP_DIR = "apps/desktop";

/** Where `db:generate` writes {@link GENERATED_CLIENT_OUTPUTS}, in-package. */
const GENERATED_CLIENT_DIR = "src/main/database/generated";

/** Workspace roots, from `pnpm-workspace.yaml`'s `packages` globs. */
const WORKSPACE_ROOTS = ["apps", "packages", "containers"];

/** A `./dist/…`-shaped export target: its first segment is the build root. */
const BUILD_OUTPUT_TARGET = /^\.\/([^/]*dist[^/]*)\//;

/**
 * The gitignored modules `prebuild` and `db:generate` write inside apps/desktop,
 * each with the script that produces it. Repo-relative and POSIX-separated, the
 * same convention as {@link dependencyBuildPrerequisites}, so one refusal
 * message can list both halves without the reader having to know which base
 * each line is relative to.
 *
 * `test/assert-test-prereqs.test.ts` pins that every entry here is
 * untracked-and-ignored, so a file that becomes committed cannot stay on this
 * list as an assertion that is always satisfied.
 *
 * @type {ReadonlyArray<{ file: string, producedBy: string }>}
 */
export const GENERATED_PREREQUISITES = [
  {
    file: `${DESKTOP_DIR}/src/shared/build-info.ts`,
    producedBy: "prebuild (scripts/write-build-info.mjs)",
  },
  {
    file: `${DESKTOP_DIR}/src/main/database/migration/migrations-manifest.ts`,
    producedBy: "prebuild (scripts/generate-migrations-manifest.mjs)",
  },
  {
    file: `${DESKTOP_DIR}/src/main/docs-help/docs-bundle-manifest.ts`,
    producedBy: "prebuild (scripts/generate-docs-bundle-manifest.mjs)",
  },
  ...GENERATED_CLIENT_OUTPUTS.map((output) => ({
    file: `${DESKTOP_DIR}/${GENERATED_CLIENT_DIR}/${output}`,
    producedBy: "db:generate (scripts/generate-prisma-client.mjs)",
  })),
];

/** Parse a manifest, or `undefined` when it is absent or unreadable. */
function readManifest(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return;
  }
}

/** Every string leaf of an `exports` map, at any conditional depth. */
function exportTargets(node, into) {
  if (typeof node === "string") {
    into.add(node);
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  for (const value of Object.values(node)) {
    exportTargets(value, into);
  }
}

/** Package directory by package name, for every workspace member. */
function workspaceMembers(repoRoot) {
  const byName = new Map();
  for (const root of WORKSPACE_ROOTS) {
    let entries = [];
    try {
      entries = readdirSync(path.join(repoRoot, root));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const directory = `${root}/${entry}`;
      const manifest = readManifest(
        path.join(repoRoot, root, entry, "package.json")
      );
      if (typeof manifest?.name === "string" && !byName.has(manifest.name)) {
        byName.set(manifest.name, directory);
      }
    }
  }
  return byName;
}

/**
 * The build-output directories `build:deps` must have produced, derived from the
 * resolution contract rather than assumed.
 *
 * A workspace dependency of apps/desktop earns an entry only when its own
 * manifest resolves at least one import through a build directory — an
 * `exports`, `main`, `module` or `types` target under `./dist/`. The dependency
 * that resolves through `./src/*.ts` needs no build and gets no entry, which is
 * why this returns one package today and not five.
 *
 * The DIRECTORY is the sentinel, not the individual emitted files: this gate
 * answers "did `build:deps` run", and pinning a file the emitter's config could
 * legitimately rename is how a gate starts failing lanes that are fine.
 *
 * @param {string} repoRoot Absolute path to the repository root.
 * @returns {ReadonlyArray<{ file: string, producedBy: string }>} Repo-relative,
 *   POSIX-separated, sorted so the message is stable.
 */
export function dependencyBuildPrerequisites(repoRoot) {
  const desktop = readManifest(
    path.join(repoRoot, "apps", "desktop", "package.json")
  );
  const declared = {
    ...(desktop?.dependencies ?? {}),
    ...(desktop?.devDependencies ?? {}),
  };
  const members = workspaceMembers(repoRoot);
  const prerequisites = new Map();

  for (const [name, range] of Object.entries(declared)) {
    if (!String(range).startsWith("workspace:")) {
      continue;
    }
    const directory = members.get(name);
    if (directory === undefined) {
      continue;
    }
    const manifest = readManifest(
      path.join(repoRoot, ...directory.split("/"), "package.json")
    );
    if (manifest === undefined) {
      continue;
    }
    const targets = new Set();
    exportTargets(manifest.exports, targets);
    for (const field of ["main", "module", "types"]) {
      exportTargets(manifest[field], targets);
    }
    for (const target of targets) {
      const outputRoot = BUILD_OUTPUT_TARGET.exec(target)?.[1];
      if (outputRoot === undefined) {
        continue;
      }
      const file = `${directory}/${outputRoot}`;
      prerequisites.set(file, {
        file,
        producedBy: `build:deps (turbo build --filter=${name})`,
      });
    }
  }

  return [...prerequisites.values()].sort((a, b) =>
    a.file.localeCompare(b.file)
  );
}

/**
 * Everything `build:prereqs` must have produced, repo-relative, in the order the
 * refusal should read: desktop's own generated modules, then its dependencies'
 * build output.
 *
 * @param {string} repoRoot Absolute path to the repository root.
 * @returns {ReadonlyArray<{ file: string, producedBy: string }>}
 */
export function allPrerequisites(repoRoot) {
  return [
    ...GENERATED_PREREQUISITES,
    ...dependencyBuildPrerequisites(repoRoot),
  ];
}

/**
 * Which of {@link allPrerequisites} are absent from `desktopDir`'s repository.
 *
 * Takes `apps/desktop` rather than the repo root so the entrypoint's argument
 * and every caller stay unchanged; the repo root is two levels up, which is
 * where `build:deps` writes the half of the answer that is not in-package.
 *
 * @param {string} desktopDir Absolute path to `apps/desktop`.
 * @returns {ReadonlyArray<{ file: string, producedBy: string }>} In list order.
 */
export function missingPrerequisites(desktopDir) {
  const repoRoot = path.join(desktopDir, "..", "..");
  return allPrerequisites(repoRoot).filter(
    (prerequisite) =>
      !existsSync(path.join(repoRoot, ...prerequisite.file.split("/")))
  );
}

/**
 * The refusal message for `desktopDir`, or `undefined` when the suite may run.
 *
 * Returned rather than thrown so the decision is drivable from a test without a
 * subprocess, and so the entrypoint owns the exit code.
 *
 * @param {string} desktopDir Absolute path to `apps/desktop`.
 * @returns {string | undefined}
 */
export function prerequisiteProblem(desktopDir) {
  const missing = missingPrerequisites(desktopDir);
  if (missing.length === 0) {
    return;
  }
  const lines = missing.map(
    (prerequisite) => `  - ${prerequisite.file}  (${prerequisite.producedBy})`
  );
  return [
    `[assert-test-prereqs] ${missing.length} module(s) the desktop main-process suite imports do not exist:`,
    ...lines,
    "[assert-test-prereqs] Run `pnpm --filter desktop run build:prereqs` first. `test:preflight` is not",
    "[assert-test-prereqs] enough — it runs `prebuild` and `db:generate` but not `build:deps`. Without",
    "[assert-test-prereqs] all three the suite fails at COLLECTION, once per importing file, and the",
    "[assert-test-prereqs] reporter renders each one as `(0 test)` — a red run that reads like a suite",
    "[assert-test-prereqs] with nothing in it.",
  ].join("\n");
}
