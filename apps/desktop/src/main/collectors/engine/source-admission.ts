import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { HarnessCollector } from "../types.js";

/**
 * Verify a collector source is a regular file under one of the collector's
 * roots. Injected test collectors can explicitly opt out when they use
 * synthetic paths without host roots.
 */
export function isImportableCollectorSource(
  collector: HarnessCollector,
  source: string
): boolean {
  // `sourceRoots` is a file-collector capability; batch collectors fall back to
  // their watchRoots. Narrow on the discriminant before reaching for it.
  const sourceRoots = collector.batch ? undefined : collector.sourceRoots?.();
  const roots = sourceRoots ?? collector.watchRoots();
  if (roots.length === 0) {
    return collector.allowUnscopedSourceAdmission === true;
  }
  return isImportableSourcePath(source, roots);
}

/** Verify a candidate source is a regular, non-symlink file under a root. */
export function isImportableSourcePath(
  source: string,
  roots: readonly string[]
): boolean {
  try {
    const stat = lstatSync(source);
    if (!stat.isFile()) {
      return false;
    }
    const realSource = realpathSync.native(source);
    return roots.some((root) => {
      try {
        return isWithinRoot(realSource, realpathSync.native(root));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isWithinRoot(realSource: string, realRoot: string): boolean {
  const relativePath = path.relative(realRoot, realSource);
  return (
    relativePath === "" ||
    (!(relativePath.startsWith("..") || path.isAbsolute(relativePath)) &&
      relativePath.length > 0)
  );
}
