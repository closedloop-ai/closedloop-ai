import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * ISS-5983: the Next file-tracing globs for the Prisma CLI's RUNTIME dependency
 * closure, computed from the pnpm store at build time.
 *
 * The ensure route spawns `prisma migrate deploy`; tracing cannot see a spawn,
 * so the CLI has to be named explicitly. Naming it is not one glob: the CLI
 * `require`s `@prisma/config` and `@prisma/engines`, `@prisma/config` pulls
 * `c12`, `effect`, `empathic` and `deepmerge-ts`, and pnpm wires all of that
 * together with SYMLINKS inside `node_modules/.pnpm/<pkg>/node_modules/` —
 * which node-glob does not follow (Next calls it without `follow`). A `**`
 * under the CLI's own directory therefore stops at the CLI's own files.
 *
 * So the closure is walked here instead of hardcoded: a hand-written list would
 * be long, and silently wrong the first time a Prisma bump changes a transitive
 * dependency. Failure is non-fatal — an unrecognizable layout yields no globs
 * rather than breaking every api build, and the route's own runtime layout
 * probe reports what is missing instead of spawning a CLI that cannot work.
 */

const PNPM_STORE_RELATIVE = path.join("node_modules", ".pnpm");
const CLI_PACKAGE_NAME = "prisma";
/** Guards against a pathological store; the real closure is dozens of entries. */
const MAX_VISITED_PACKAGES = 500;

type StoreIndex = {
  entries: string[];
  storeDirectory: string;
};

function readStoreIndex(monorepoRoot: string): StoreIndex | null {
  const storeDirectory = path.join(monorepoRoot, PNPM_STORE_RELATIVE);
  try {
    return { entries: readdirSync(storeDirectory), storeDirectory };
  } catch {
    return null;
  }
}

/**
 * The store directories holding `packageName`. pnpm names them
 * `<name with "/" as "+">@<version>[_<peer hash>]`, and the character right
 * after the name is always `@`, so a prefix match cannot collide with a
 * longer package name.
 */
function storeDirectoriesFor(index: StoreIndex, packageName: string): string[] {
  const prefix = `${packageName.replace("/", "+")}@`;
  return index.entries.filter((entry) => entry.startsWith(prefix));
}

function readRuntimeDependencies(
  index: StoreIndex,
  storeDirectory: string,
  packageName: string
): string[] {
  const manifestPath = path.join(
    index.storeDirectory,
    storeDirectory,
    "node_modules",
    packageName,
    "package.json"
  );
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/**
 * Tracing globs, RELATIVE TO `apps/api` — Next matches include globs with the
 * Next project directory as cwd, not `outputFileTracingRoot`.
 */
export function prismaCliTracingIncludes(monorepoRoot: string): string[] {
  const index = readStoreIndex(monorepoRoot);
  if (!index) {
    return [];
  }

  const globs: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [CLI_PACKAGE_NAME];

  while (queue.length > 0 && visited.size < MAX_VISITED_PACKAGES) {
    const packageName = queue.shift();
    if (packageName === undefined || visited.has(packageName)) {
      continue;
    }
    visited.add(packageName);

    for (const storeDirectory of storeDirectoriesFor(index, packageName)) {
      globs.push(
        `../../${PNPM_STORE_RELATIVE}/${storeDirectory}/node_modules/${packageName}/**`
      );
      queue.push(
        ...readRuntimeDependencies(index, storeDirectory, packageName)
      );
    }
  }

  return globs;
}
