import { existsSync } from "node:fs";
import path from "node:path";

/**
 * `@repo/<pkg>/<subpath>`, or the same under the published `@closedloop-ai/`
 * scope (design-system, loops-api, shared-platform, telemetry-contract), whose
 * directory is also `packages/<pkg>`. A bare `@scope/<pkg>` has no file to
 * point at.
 */
const WORKSPACE_SPECIFIER = /^@(?:repo|closedloop-ai)\/([^/]+)\/(.+)$/;

/**
 * Where a module specifier written in `fromFile` lands on disk, or nothing.
 *
 * Extracted from `surface-capability-parity` so the SPREAD reader
 * (`jsx-spread-props`) can follow an imported prop set without importing the
 * module that consumes it — that direction is a cycle.
 *
 * Returns `undefined` rather than guessing, and every caller refuses on it: an
 * under-read prop set is the failure these guards exist to stop.
 */
export function resolveModuleFile(
  fromFile: string,
  moduleSpecifier: string
): string | undefined {
  const base = moduleSpecifier.startsWith(".")
    ? path.resolve(path.dirname(fromFile), moduleSpecifier)
    : workspaceSubpathBase(fromFile, moduleSpecifier);
  if (!base) {
    return undefined;
  }
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Where a workspace `<scope>/<pkg>/<subpath>` lands on disk.
 *
 * Resolved off the READING FILE's own path rather than a passed-in root. Two
 * ancestors can carry the workspace: a file under `packages/` finds its sibling
 * package beside it, and a file under `apps/` finds `packages/` beside `apps/`.
 * Anything that is not a workspace specifier under one of those returns nothing.
 */
function workspaceSubpathBase(
  fromFile: string,
  moduleSpecifier: string
): string | undefined {
  const match = WORKSPACE_SPECIFIER.exec(moduleSpecifier);
  if (!match) {
    return undefined;
  }
  const [, packageName, subpath] = match;
  const segments = fromFile.split(path.sep);
  const packagesAt = segments.lastIndexOf("packages");
  if (packagesAt !== -1) {
    return path.join(
      segments.slice(0, packagesAt + 1).join(path.sep),
      packageName,
      subpath
    );
  }
  const appsAt = segments.lastIndexOf("apps");
  if (appsAt === -1) {
    return undefined;
  }
  return path.join(
    segments.slice(0, appsAt).join(path.sep),
    "packages",
    packageName,
    subpath
  );
}
