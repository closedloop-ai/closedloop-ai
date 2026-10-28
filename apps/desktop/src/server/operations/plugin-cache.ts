import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type InstalledPluginsFile = {
  version?: number;
  plugins?: Record<string, InstalledPluginEntry[]>;
};

type InstalledPluginEntry = {
  installPath?: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
};

const CODE_PLUGIN_REF = "code@closedloop-ai";

function getDefaultRegistryPath(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "installed_plugins.json"
  );
}

function readInstalledPluginsFile(
  registryPath?: string
): InstalledPluginsFile | null {
  try {
    return JSON.parse(
      readFileSync(registryPath ?? getDefaultRegistryPath(), "utf-8")
    ) as InstalledPluginsFile;
  } catch {
    return null;
  }
}

function entryHasExistingInstallPath(entry: InstalledPluginEntry): boolean {
  return Boolean(entry.installPath && existsSync(entry.installPath));
}

/**
 * Legacy registry entries that predate `scope` count as user-scoped when their
 * install path still exists.
 */
function isUserScopedRegistryEntry(entry: InstalledPluginEntry): boolean {
  return (
    entry.scope === "user" ||
    (entry.scope === undefined && entryHasExistingInstallPath(entry))
  );
}

/**
 * The registry version of the user-scoped `code@closedloop-ai` install, or
 * `undefined` when there is no such install whose path still exists, or the
 * registry marks one of those installs disabled.
 */
function readInstalledCodePluginVersion(
  registryPath?: string
): string | undefined {
  const entries =
    readInstalledPluginsFile(registryPath)?.plugins?.[CODE_PLUGIN_REF] ?? [];
  const existingUserEntries = entries
    .filter(isUserScopedRegistryEntry)
    .filter(entryHasExistingInstallPath);
  if (
    existingUserEntries.length === 0 ||
    existingUserEntries.some((entry) => entry.enabled === false)
  ) {
    return;
  }
  return existingUserEntries.at(-1)?.version;
}

/** Semver pattern that also accepts pre-release / build metadata suffixes (AC-049 sandbox). */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+([-+][\w.]+)?$/;
const MAX_VERSION_LENGTH = 64;

function isValidSemver(value: string): boolean {
  return value.length <= MAX_VERSION_LENGTH && SEMVER_PATTERN.test(value);
}

/**
 * Return the installed version string for the `code@closedloop-ai` plugin.
 *
 * Resolution order:
 *  1. `CL_PLUGIN_VERSION` environment variable (AC-049 sandbox override).
 *  2. The user-scoped `code@closedloop-ai` entry in Claude's plugin registry.
 *
 * The resolved string is validated against a semver pattern and a 64-character
 * maximum length. Returns `'unknown'` on any failure.
 *
 * @param cacheRoot - Optional registry path override, for testability.
 */
export function getCodePluginVersion(cacheRoot?: string): string {
  try {
    // AC-049 sandbox: allow env-var override for controlled test environments.
    const envVersion = process.env.CL_PLUGIN_VERSION;
    if (envVersion) {
      return isValidSemver(envVersion) ? envVersion : "unknown";
    }

    const version = readInstalledCodePluginVersion(cacheRoot);
    if (!(version && isValidSemver(version))) {
      return "unknown";
    }
    return version;
  } catch {
    return "unknown";
  }
}
