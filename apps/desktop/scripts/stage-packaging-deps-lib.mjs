// Pure dependency-staging logic extracted from stage-packaging-app.mjs
// (ISS-5303) so it can be unit-tested. The entrypoint cannot be imported by a
// test: it spawns `pnpm list`, `pnpm pack`, `tar` and `pnpm install` at module
// scope and rewrites the packaging stage directory as a side effect of being
// loaded. Nothing in this module touches the filesystem or spawns a process.
//
// `isBundledWorkspaceDependency` used to close over the entrypoint's
// `workspaceDependencyPackages` Map. It now takes the packed closure's package
// NAMES as an argument so a test can classify against a synthetic closure, while
// the entrypoint keeps deriving the real one from DESKTOP_RUNTIME_CLOSURE — the
// SSOT in ./packaging-workspace-deps.mjs, which is not duplicated here.

import { isWorkspaceProtocolSpec } from "./packaging-workspace-deps.mjs";

/**
 * Resolve the spec a dependency is written into the staged package.json with.
 *
 * Precedence, highest first:
 *   1. the `file:` tarball of a packed workspace closure member,
 *   2. the concrete `resolved` URL pnpm reported for the installed dependency,
 *   3. the range declared in the source manifest (prod, then optional),
 *   4. the installed version.
 *
 * @param {{ dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }} packageJson
 *   The source apps/desktop manifest.
 * @param {string} dependencyName
 * @param {{ version?: string, resolved?: string }} dependency The `pnpm list` entry.
 * @param {ReadonlyMap<string, string>} workspaceTarballSpecs Packed member name → `file:` spec.
 * @returns {string | undefined} The spec to stage, or undefined when nothing declares one.
 */
export function resolveStageDependencySpec(
  packageJson,
  dependencyName,
  dependency,
  workspaceTarballSpecs
) {
  const workspaceTarballSpec = workspaceTarballSpecs.get(dependencyName);
  if (workspaceTarballSpec) {
    return workspaceTarballSpec;
  }

  if (
    typeof dependency.resolved === "string" &&
    dependency.resolved.length > 0
  ) {
    return dependency.resolved;
  }

  return (
    packageJson.dependencies?.[dependencyName] ??
    packageJson.optionalDependencies?.[dependencyName] ??
    dependency.version
  );
}

/**
 * Whether a workspace dependency is inlined into the bundle by electron-vite (or
 * Vite, for the renderer) and must therefore be dropped from the staged closure.
 *
 * A member of the packed closure is NOT bundled — it is imported as an external
 * at runtime, so it is packed as a tarball and installed. Everything else that
 * declares a `workspace:`/`link:` spec is bundled from source; leaving it in the
 * staged manifest would surface that unresolvable spec to `pnpm install` and
 * abort staging.
 *
 * @param {{ dependencies?: Record<string, string> }} packageJson The source manifest.
 * @param {string} dependencyName
 * @param {ReadonlySet<string>} packedWorkspacePackageNames Names of the packed closure members.
 * @returns {boolean}
 */
export function isBundledWorkspaceDependency(
  packageJson,
  dependencyName,
  packedWorkspacePackageNames
) {
  if (packedWorkspacePackageNames.has(dependencyName)) {
    return false;
  }
  return isWorkspaceProtocolSpec(packageJson.dependencies?.[dependencyName]);
}

/**
 * Fail staging if any staged dependency still carries a `workspace:`/`link:`
 * spec. `pnpm install` cannot resolve one outside the source workspace, so this
 * is the last guard before the staged manifest is written.
 *
 * @param {{ dependencies?: Record<string, string> }} stagePackageJson
 * @returns {void}
 * @throws {Error} Naming the offending dependency and its spec.
 */
export function assertNoUnresolvedWorkspaceSpecs(stagePackageJson) {
  for (const [dependencyName, dependencySpec] of Object.entries(
    stagePackageJson.dependencies ?? {}
  )) {
    if (isWorkspaceProtocolSpec(dependencySpec)) {
      throw new Error(
        `Staged dependency ${dependencyName} still uses unresolved spec ${dependencySpec}.`
      );
    }
  }
}

/**
 * Parse the JSON payload out of a pnpm command's stdout, which may carry warning
 * lines before the payload. Falls back to scanning forward from the first `[` or
 * `{` for the shortest prefix that parses.
 *
 * @param {string} output Raw stdout.
 * @returns {unknown} The parsed payload.
 * @throws {Error} When no prefix of the output parses as JSON.
 */
export function parseJsonFromCommandOutput(output) {
  const trimmedOutput = output.trim();

  try {
    return JSON.parse(trimmedOutput);
  } catch {
    // pnpm may emit warnings before the JSON payload.
  }

  const startIndexCandidates = [
    trimmedOutput.indexOf("["),
    trimmedOutput.indexOf("{"),
  ].filter((index) => index >= 0);

  const startIndex =
    startIndexCandidates.length > 0 ? Math.min(...startIndexCandidates) : 0;

  for (let index = startIndex; index < trimmedOutput.length; index += 1) {
    const candidate = trimmedOutput.slice(startIndex, index + 1);

    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning until the JSON closes.
    }
  }

  throw new Error("Failed to parse pnpm dependency output.");
}
