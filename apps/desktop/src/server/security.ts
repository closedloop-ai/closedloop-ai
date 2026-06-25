import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Observability } from "../main/observability.js";
import { expandHomePath } from "../shared/path-utils.js";

export class DirectoryNotAllowedError extends Error {
  readonly targetPath: string;

  constructor(targetPath: string) {
    super("directory not allowed");
    this.targetPath = targetPath;
  }
}

export function isPathAllowed(
  targetPath: string,
  allowedDirectories: string[]
): boolean {
  const expandedTarget = path.resolve(expandHomePath(targetPath));
  const resolvedTarget = canonicalizePathForPolicy(targetPath);

  // Check both the original (non-canonicalized) and resolved (canonicalized) paths
  // This ensures we catch sensitive paths even if they are symlinks (e.g., ~/.ssh -> real location)
  if (
    isSensitiveDeniedPath(expandedTarget) ||
    isSensitiveDeniedPath(resolvedTarget)
  ) {
    return false;
  }

  for (const allowedDirectory of allowedDirectories) {
    const resolvedAllowedDirectory =
      canonicalizePathForPolicy(allowedDirectory);
    if (resolvedTarget === resolvedAllowedDirectory) {
      return true;
    }

    const prefix = resolvedAllowedDirectory.endsWith(path.sep)
      ? resolvedAllowedDirectory
      : `${resolvedAllowedDirectory}${path.sep}`;

    if (resolvedTarget.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

export function assertPathAllowed(
  targetPath: string,
  allowedDirectories: string[]
): void {
  if (!isPathAllowed(targetPath, allowedDirectories)) {
    Observability.sandboxBlocked("path_denied");
    throw new DirectoryNotAllowedError(targetPath);
  }
}

function canonicalizePathForPolicy(inputPath: string): string {
  const absolutePath = path.resolve(expandHomePath(inputPath));
  return resolveWithNearestRealpath(absolutePath);
}

function resolveWithNearestRealpath(absolutePath: string): string {
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    const remainder: string[] = [];
    let probe = absolutePath;
    while (true) {
      if (fs.existsSync(probe)) {
        break;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        return absolutePath;
      }
      remainder.unshift(path.basename(probe));
      probe = parent;
    }

    try {
      const canonicalBase = fs.realpathSync.native(probe);
      return path.join(canonicalBase, ...remainder);
    } catch {
      return absolutePath;
    }
  }
}

function isSensitiveDeniedPath(targetPath: string): boolean {
  const lowerTarget = targetPath.toLowerCase();
  return SENSITIVE_DENY_PATHS.some((blockedPath) => {
    // Check both the original blocked path and its canonical form
    // This catches direct matches and symlinked paths
    const lowerBlockedOriginal = blockedPath.toLowerCase();
    const isMatchOriginal =
      lowerTarget === lowerBlockedOriginal ||
      lowerTarget.startsWith(
        lowerBlockedOriginal.endsWith(path.sep)
          ? lowerBlockedOriginal
          : `${lowerBlockedOriginal}${path.sep}`
      );

    if (isMatchOriginal) {
      return true;
    }

    const canonicalBlocked = canonicalizePathForPolicy(blockedPath);
    const lowerBlocked = canonicalBlocked.toLowerCase();
    return (
      lowerTarget === lowerBlocked ||
      lowerTarget.startsWith(
        lowerBlocked.endsWith(path.sep)
          ? lowerBlocked
          : `${lowerBlocked}${path.sep}`
      )
    );
  });
}

const SENSITIVE_DENY_PATHS = [
  path.join(os.homedir(), ".ssh"),
  path.join(os.homedir(), ".gnupg"),
  path.join(os.homedir(), ".aws"),
  path.join(os.homedir(), "Library", "Keychains"),
  "/etc",
  "/bin",
  "/sbin",
];
