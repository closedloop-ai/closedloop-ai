// @ts-check

/**
 * ISS-5303 — the testable half of `write-build-info.mjs`.
 *
 * The entrypoint is a shell: it resolves the desktop paths from
 * `import.meta.url`, shells out to `git rev-parse HEAD`, and reads
 * `package.json`. Everything that makes a DECISION lives here — the source
 * render and the content-aware write — so the behaviour can be driven directly
 * instead of only through a subprocess that needs a real git checkout.
 *
 * This module is import-safe: no subprocess, no path derivation and no
 * filesystem access at module scope. Every path it touches is injected.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * What the content-aware write actually did. The entrypoint prints one line per
 * outcome, and `pnpm prebuild` runs on every local launch, so "unchanged" is the
 * common case and it must not churn the file's mtime.
 */
export const BuildInfoWriteOutcome = {
  Unchanged: "unchanged",
  Wrote: "wrote",
};

/**
 * Render the generated `build-info.ts` source.
 *
 * @param {{ commitHash: string; appVersion: string }} fields
 * @returns {string}
 */
export function renderBuildInfoSource({ commitHash, appVersion }) {
  return `// AUTO-GENERATED — do not edit
export const BUILD_COMMIT_HASH = "${commitHash}";
export const BUILD_APP_VERSION = "${appVersion}";
`;
}

/**
 * Pull the app version out of a parsed `package.json`.
 *
 * A missing or non-string `version` degrades to `""` rather than emitting
 * `undefined` into the generated source: `BUILD_APP_VERSION` is the
 * authoritative `service.version` for telemetry (FEA-2199), and the string
 * `"undefined"` would be a plausible-but-wrong version facet.
 *
 * @param {unknown} packageJson
 * @returns {string}
 */
export function resolveAppVersion(packageJson) {
  if (
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson &&
    typeof packageJson.version === "string"
  ) {
    return packageJson.version;
  }

  return "";
}

/**
 * Write the generated source only when its bytes would change.
 *
 * Repeated local launches run `pnpm prebuild`, and an unconditional write would
 * bump the mtime of a file both main and renderer import — invalidating
 * incremental builds for no content change.
 *
 * @param {{ outFile: string; contents: string; displayPath: string }} io
 * @returns {{ outcome: "unchanged" | "wrote"; message: string }}
 */
export function writeBuildInfoIfChanged({ outFile, contents, displayPath }) {
  if (existsSync(outFile) && readFileSync(outFile, "utf8") === contents) {
    return {
      outcome: BuildInfoWriteOutcome.Unchanged,
      message: "write-build-info: unchanged\n",
    };
  }

  writeFileSync(outFile, contents, "utf8");

  return {
    outcome: BuildInfoWriteOutcome.Wrote,
    message: `write-build-info: wrote ${displayPath}\n`,
  };
}
