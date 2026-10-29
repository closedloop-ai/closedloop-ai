#!/usr/bin/env node
// @ts-check

/**
 * ISS-12135: exit 1, with the reason on stderr, when the Desktop main bundle
 * would not load under Electron. Defaults to the package's `main`, so
 * `pnpm start` can run it ahead of `electron .`. Re-executes itself with
 * `--experimental-import-meta-resolve` when started without it, since the walk
 * resolves against each chunk's own URL.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findUnresolvedBundleImports,
  IMPORT_META_RESOLVE_FLAG,
  missingEntryMessage,
  unresolvedImportsMessage,
} from "./main-bundle-launch-preflight-lib.mjs";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));

if (process.execArgv.includes(IMPORT_META_RESOLVE_FLAG)) {
  const entry = path.resolve(process.argv[2] ?? defaultEntry());
  const problem = launchProblem(entry);
  if (problem !== undefined) {
    console.error(problem);
    // Not `process.exit()`: stderr is a pipe under the harness and an
    // immediate exit can truncate the message.
    process.exitCode = 1;
  }
} else {
  const child = spawnSync(
    process.execPath,
    [
      IMPORT_META_RESOLVE_FLAG,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" }
  );
  process.exitCode = child.status ?? 1;
}

/** @returns {string} */
function defaultEntry() {
  const manifest = JSON.parse(
    readFileSync(path.join(desktopDir, "package.json"), "utf8")
  );
  return path.join(desktopDir, manifest.main);
}

/**
 * @param {string} entry
 * @returns {string | undefined}
 */
function launchProblem(entry) {
  let unresolved;
  try {
    unresolved = findUnresolvedBundleImports(entry, (specifier, parentUrl) =>
      import.meta.resolve(specifier, parentUrl)
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return missingEntryMessage(entry);
    }
    throw error;
  }
  return unresolved.length > 0
    ? unresolvedImportsMessage(entry, unresolved)
    : undefined;
}
