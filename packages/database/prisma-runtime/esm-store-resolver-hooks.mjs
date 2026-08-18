import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * ISS-6781: module customization hooks that resolve a bare ES-module specifier
 * the way pnpm would have LINKED it, for a bundle that carries the pnpm store's
 * files but none of its symlinks. Registered by `esm-store-resolver.mjs`; see
 * that file for why the bundle looks like this.
 *
 * The rule is pnpm's own. A package importing `jiti` gets the `jiti` its
 * manifest declares — so the importer's nearest `package.json` is read, the
 * store entries for that name are ordered with the declared major first, and
 * resolution is retried FROM inside each candidate's `node_modules` directory,
 * where Node's ordinary walk-up finds the package with its `exports` map and
 * conditions intact. Only when nothing matches does the default resolution
 * run, and only when THAT fails is any store copy accepted.
 *
 * "Declared major first, then default" is the load-bearing order, and it is
 * the difference from `NODE_PATH`. In production the default walk-up did find
 * a `jiti` — a CommonJS one, so `c12`'s named import failed with the exact
 * ISS-6781 message. A hook that only rescued MODULE_NOT_FOUND would have let
 * that wrong-but-present copy through. Preferring what the importer declares
 * is what makes this correct rather than merely permissive.
 *
 * Runs on the loader thread; `node:` builtins only.
 */

/** `name` or `@scope/name`, with an optional subpath — never relative or a URL. */
const BARE_SPECIFIER = /^(@[^/]+\/[^/]+|[^./@][^/]*)(\/.*)?$/;
const LEADING_MAJOR = /(\d+)/;
/** Something inside a store `node_modules` dir, so the walk-up starts there. */
const RESOLUTION_ANCHOR = "__esm-store-resolver-anchor.mjs";

/** @type {Array<{ dir: string, name: string, major: number, version: string }>} */
let storeEntries = [];
/** @type {Map<string, Promise<Record<string, unknown> | null>>} */
const manifestByDir = new Map();

/**
 * @param {{ storeDirs: string[] }} data
 */
export function initialize({ storeDirs }) {
  storeEntries = storeDirs.flatMap((dir) => {
    const entry = path.basename(path.dirname(dir));
    const versionAt = entry.indexOf("@", 1);
    if (versionAt === -1) {
      return [];
    }
    const version = entry.slice(versionAt + 1).split("_")[0] ?? "";
    const major = Number.parseInt(version, 10);
    if (Number.isNaN(major)) {
      return [];
    }
    return [
      {
        dir,
        name: entry.slice(0, versionAt).replace("+", "/"),
        major,
        version,
      },
    ];
  });
}

/**
 * @param {string} specifier
 * @param {{ parentURL?: string, conditions: string[], importAttributes: object }} context
 * @param {(specifier: string, context?: object) => Promise<{ url: string }>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  const match = BARE_SPECIFIER.exec(specifier);
  if (
    !match ||
    isBuiltin(specifier) ||
    URL.canParse(specifier) ||
    !context.parentURL?.startsWith("file:")
  ) {
    return nextResolve(specifier, context);
  }

  const packageName = match[1];
  const candidates = storeEntries.filter((entry) => entry.name === packageName);
  if (candidates.length === 0) {
    return nextResolve(specifier, context);
  }

  const declaredMajor = await declaredDependencyMajor(
    fileURLToPath(context.parentURL),
    packageName
  );
  const preferred = candidates.filter((entry) => entry.major === declaredMajor);
  const fromStore = (entries) =>
    resolveFromAny(entries, specifier, context, nextResolve);

  const declared = await fromStore(preferred);
  if (declared) {
    return declared;
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const fallback = await fromStore(candidates);
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

/**
 * The first store entry from which `specifier` resolves, highest version
 * first, or `null` when none does.
 */
async function resolveFromAny(entries, specifier, context, nextResolve) {
  const ordered = [...entries].sort((a, b) =>
    compareVersionsDesc(a.version, b.version)
  );
  for (const entry of ordered) {
    const anchor = pathToFileURL(path.join(entry.dir, RESOLUTION_ANCHOR)).href;
    try {
      return await nextResolve(specifier, { ...context, parentURL: anchor });
    } catch {
      // Not resolvable from this store entry — try the next.
    }
  }
  return null;
}

/**
 * The major version the importer's own manifest declares for `packageName`,
 * across regular, optional and peer dependencies, or `null` when it declares
 * none. `^2.6.1`, `~2.6.0`, `2.x`, `>=2.0.0` all read as 2 — enough to tell
 * apart the two majors a store can hold, which is the ISS-6781 case, without
 * carrying a semver implementation onto the loader thread.
 */
async function declaredDependencyMajor(importerPath, packageName) {
  const manifest = await nearestManifest(path.dirname(importerPath));
  if (!manifest) {
    return null;
  }
  const range =
    manifest.dependencies?.[packageName] ??
    manifest.optionalDependencies?.[packageName] ??
    manifest.peerDependencies?.[packageName];
  const major = LEADING_MAJOR.exec(range ?? "");
  return major ? Number.parseInt(major[1], 10) : null;
}

/**
 * The closest ancestor `package.json` that names a package. Memoized per
 * directory: the CLI's closure resolves thousands of specifiers, and every
 * one of them would otherwise re-read the same handful of manifests.
 */
function nearestManifest(dir) {
  const cached = manifestByDir.get(dir);
  if (cached) {
    return cached;
  }
  const lookup = readManifest(dir).then((manifest) => {
    if (manifest) {
      return manifest;
    }
    const parent = path.dirname(dir);
    return parent === dir ? null : nearestManifest(parent);
  });
  manifestByDir.set(dir, lookup);
  return lookup;
}

async function readManifest(dir) {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(dir, "package.json"), "utf8")
    );
    return typeof manifest?.name === "string" ? manifest : null;
  } catch {
    return null;
  }
}

function compareVersionsDesc(a, b) {
  const partsA = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const partsB = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const difference = (partsB[index] ?? 0) - (partsA[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
