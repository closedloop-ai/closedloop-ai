// Pure helpers shared by stage-packaging-app.mjs, extracted so the subtle
// workspace-spec parsing can be unit-tested without running the full stager.

import { createRequire } from "node:module";
import path from "node:path";

// Canonical Desktop runtime workspace import closure (SSOT).
//
// These are the workspace packages that must end up as real files in the
// packaged runtime dependency closure — they are imported as EXTERNALS at
// runtime (resolved from node_modules), not inlined by the bundler. Each is
// packed as a tarball and installed so the asar carries its real files.
//
//   - @closedloop-ai/telemetry-contract — imported by Desktop OTel bootstrap
//     via its `exports` subpaths and left external by electron-vite, so packaged
//     Desktop needs its built files in node_modules at runtime. It is the only
//     remaining external workspace member — the sole package still published and
//     pre-built to `dist`.
//
// NOT listed — bundled from source by electron-vite (PLN-999), so they never
// resolve from node_modules at runtime and are excluded from the packaged
// closure by isBundledWorkspaceDependency in stage-packaging-app.mjs:
//   - @repo/api — main/preload inline it from source (electron.vite.config.ts
//     aliases it to packages/api). Its transitive `@repo/shared-platform`
//     (FEA-1513) is inlined with it.
//   - @repo/lib — surface-agnostic business logic incl. the harness parser
//     cores (FEA-2717); main inlines it from source, same as @repo/api
//     (WORKSPACE_INLINE + alias in electron.vite.config.ts).
//   - @closedloop-ai/loops-api — its `exports` now resolve to `.ts` source (it is no
//     longer published/pre-built), so main inlines it from source; its only
//     runtime dep `@pydantic/genai-prices` is bundled with it (not externalized),
//     so it needs no closure entry.
//   - @repo/app, @closedloop-ai/design-system — renderer-only; Vite bundles them.
//
// `packages/api/**`, `packages/shared-platform/**`, and `packages/loops-api/**`
// are now *bundled build inputs* (a change to them alters the bundle), so CI path
// filters (pr-test.yml, desktop-packaging-validation gating) still cover them
// even though they left the staged runtime closure.
//
// This is the SINGLE SOURCE OF TRUTH consumed by stage-packaging-app.mjs, which
// builds its `workspaceDependencyPackages` Map from it.
// `packageDir` is the directory name under `packages/`.
export const DESKTOP_RUNTIME_CLOSURE = [
  {
    packageName: "@closedloop-ai/telemetry-contract",
    packageDir: "telemetry-contract",
  },
];

// A `workspace:` spec whose range begins with one of these is a plain version
// range (`*`, `^…`, `~…`, a digit) rather than an aliased `<name>@<range>` spec.
const WORKSPACE_PLAIN_RANGE_PATTERN = /^[*^~\d]/;

/**
 * Resolve the real package name a `workspace:`/`link:` dependency installs.
 *
 * Plain ranges (`workspace:*`, `workspace:^1.2.3`, `link:../x`) install under the
 * dependency key. An aliased spec (`workspace:@scope/name@range` or
 * `workspace:name@range`) installs the named target package under the key — e.g.
 * `"@repo/shared-platform": "workspace:@closedloop-ai/shared-platform@*"` installs
 * the `@repo/shared-platform` package, imported as `@repo/shared-platform`.
 *
 * @param {string} dependencyKey The package.json dependency key.
 * @param {string} sourceSpec The declared `workspace:`/`link:` spec.
 * @returns {string} The target package name to look up among packed members.
 */
export function resolveWorkspaceDependencyTarget(dependencyKey, sourceSpec) {
  if (sourceSpec.startsWith("link:")) {
    return dependencyKey;
  }
  const rangeOrAlias = sourceSpec.slice("workspace:".length);
  if (rangeOrAlias === "" || WORKSPACE_PLAIN_RANGE_PATTERN.test(rangeOrAlias)) {
    return dependencyKey;
  }
  const versionSeparatorIndex = rangeOrAlias.lastIndexOf("@");
  return versionSeparatorIndex > 0
    ? rangeOrAlias.slice(0, versionSeparatorIndex)
    : rangeOrAlias;
}

/**
 * Whether a dependency spec resolves through the workspace (and so cannot be
 * fetched from a registry once `pnpm pack` rewrites it inside a tarball).
 *
 * @param {unknown} spec
 * @returns {boolean}
 */
export function isWorkspaceProtocolSpec(spec) {
  return (
    typeof spec === "string" &&
    (spec.startsWith("workspace:") || spec.startsWith("link:"))
  );
}

/**
 * Resolve a production runtime file from a staged Desktop app directory.
 *
 * @param {string} stageAppDir Directory containing the staged package.json.
 * @param {string} packageName Bare package name, such as `@repo/api`.
 * @param {string} relativeFile Package-relative runtime file path.
 * @returns {string} Absolute resolved file path.
 */
export function resolveStagedPackageRuntimeFile(
  stageAppDir,
  packageName,
  relativeFile
) {
  const stageRequire = createRequire(path.join(stageAppDir, "package.json"));
  return stageRequire.resolve(path.posix.join(packageName, relativeFile));
}
