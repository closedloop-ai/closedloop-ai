// @ts-check

/**
 * ISS-12135: refuse to start Electron on a main bundle that cannot load.
 *
 * Electron reports both failures this catches as a native modal on whatever
 * screen the machine has, not as a test error: a missing entry opens "Unable
 * to find Electron app", and an import that does not resolve reaches the
 * bootstrap crash handler's "Closedloop encountered a fatal error" box. On a
 * shared machine that modal lands in front of a person, so the check runs
 * before the spawn.
 *
 * Resolution uses Node's own ESM resolver (`import.meta.resolve` with a parent
 * URL), which needs `--experimental-import-meta-resolve` on Node 24; without
 * the flag the parent argument is ignored and every specifier would resolve
 * against this file. {@link assertMainBundleLaunchable} therefore runs the walk
 * in a child that has the flag.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript6";

export const IMPORT_META_RESOLVE_FLAG = "--experimental-import-meta-resolve";

const REBUILD_COMMAND = "pnpm -C apps/desktop build";

const PREFLIGHT_CLI = fileURLToPath(
  new URL("./main-bundle-launch-preflight.mjs", import.meta.url)
);

/** Provided by the Electron runtime, never by node_modules. */
const ELECTRON_PROVIDED_SPECIFIER = /^electron(\/|$)/;
const RELATIVE_SPECIFIER = /^\.\.?\//;
const FILE_URL_PREFIX = "file:";
const TYPESCRIPT_SOURCE = /\.(ts|tsx|mts|cts)$/;

/** Entry paths already proven loadable in this process, keyed with mtime. */
const provenLaunchable = new Set();

/**
 * @param {string} entryPath
 * @returns {string}
 */
export function missingEntryMessage(entryPath) {
  return `desktop launch preflight: ${entryPath} does not exist, so Electron was not started. Build this checkout first: ${REBUILD_COMMAND}`;
}

/**
 * Every import reachable from `entryPath` through the bundle's own relative
 * chunks that would fail to load, as `{ importer, specifier, reason }`.
 *
 * Bare specifiers are resolved, not followed: a package that resolves is the
 * package's own business, and walking node_modules would multiply the cost.
 *
 * @param {string} entryPath
 * @param {(specifier: string, parentUrl: string) => string} resolveSpecifier
 * @returns {{ importer: string, specifier: string, reason: string }[]}
 */
export function findUnresolvedBundleImports(entryPath, resolveSpecifier) {
  /** @type {{ importer: string, specifier: string, reason: string }[]} */
  const unresolved = [];
  const visited = new Set();
  const queue = [path.resolve(entryPath)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of moduleSpecifiers(file)) {
      if (RELATIVE_SPECIFIER.test(specifier)) {
        const target = path.resolve(path.dirname(file), specifier);
        if (isFile(target)) {
          queue.push(target);
        } else {
          unresolved.push({
            importer: file,
            specifier,
            reason: "no such chunk",
          });
        }
        continue;
      }
      if (ELECTRON_PROVIDED_SPECIFIER.test(specifier)) {
        continue;
      }
      const reason = bareSpecifierProblem(
        specifier,
        pathToFileURL(file).href,
        resolveSpecifier
      );
      if (reason !== undefined) {
        unresolved.push({ importer: file, specifier, reason });
      }
    }
  }
  return unresolved;
}

/**
 * @param {string} entryPath
 * @param {readonly { importer: string, specifier: string, reason: string }[]} unresolved
 * @returns {string}
 */
export function unresolvedImportsMessage(entryPath, unresolved) {
  const root = path.dirname(entryPath);
  const lines = unresolved.map(
    ({ importer, specifier, reason }) =>
      `  ${path.relative(root, importer)} imports "${specifier}" (${reason})`
  );
  return [
    `desktop launch preflight: ${entryPath} cannot load, so Electron was not started.`,
    ...lines,
    `Rebuild this checkout (${REBUILD_COMMAND}). If a clean build still fails, the main process imports a package the main bundle leaves external; see WORKSPACE_INLINE in apps/desktop/vite.main.config.ts.`,
  ].join("\n");
}

/**
 * Throw, without starting Electron, unless `entryPath` exists and every import
 * its bundle reaches resolves. Memoized per entry and mtime, because the
 * harness launches the same build dozens of times per run.
 *
 * @param {string} entryPath
 * @returns {void}
 */
export function assertMainBundleLaunchable(entryPath) {
  const entry = path.resolve(entryPath);
  if (!isFile(entry)) {
    throw new Error(missingEntryMessage(entry));
  }
  const key = `${entry}\0${statSync(entry).mtimeMs}`;
  if (provenLaunchable.has(key)) {
    return;
  }
  const result = spawnSync(
    process.execPath,
    [IMPORT_META_RESOLVE_FLAG, PREFLIGHT_CLI, entry],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `desktop launch preflight could not check ${entry}: ${result.error?.message ?? `exit ${result.status}`}`
    );
  }
  provenLaunchable.add(key);
}

/**
 * @param {string} specifier
 * @param {string} parentUrl
 * @param {(specifier: string, parentUrl: string) => string} resolveSpecifier
 * @returns {string | undefined}
 */
function bareSpecifierProblem(specifier, parentUrl, resolveSpecifier) {
  let resolved;
  try {
    resolved = resolveSpecifier(specifier, parentUrl);
  } catch (error) {
    return error instanceof Error
      ? error.message.split("\n")[0]
      : String(error);
  }
  if (!resolved.startsWith(FILE_URL_PREFIX)) {
    return;
  }
  const resolvedPath = fileURLToPath(resolved);
  // The resolver maps a subpath of a package with no `exports` map straight to
  // a path without checking it exists; the loader then fails on it at runtime.
  if (!isFile(resolvedPath)) {
    return `resolves to missing ${resolvedPath}`;
  }
  // A package whose `main` is its TypeScript source (`@closedloop-ai/design-system`)
  // resolves to a real file that Electron's Node then refuses with
  // ERR_UNKNOWN_FILE_EXTENSION.
  if (TYPESCRIPT_SOURCE.test(resolvedPath)) {
    return `resolves to TypeScript source ${resolvedPath}, which Node cannot load`;
  }
  return;
}

/**
 * The specifiers `file` statically imports, re-exports from, or passes to
 * `import()` as a literal, read from a real parse. A token scanner loses sync
 * on a backtick inside a regex literal and then reads imports out of comments.
 *
 * @param {string} file
 * @returns {string[]}
 */
function moduleSpecifiers(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  /** @type {string[]} */
  const specifiers = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** @param {string} candidate */
function isFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile();
}
