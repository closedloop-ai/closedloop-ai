import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetMcpDetectionCache } from "../../server/operations/mcp-detection.js";
import { resetResolvedClaudePath } from "../../server/operations/symphony-loop.js";
import type {
  BinaryPathPatch,
  CliBinaryTool,
} from "../ipc/binary-paths-ipc.js";
import type { SettingsStore } from "./settings-store.js";

/** Leading `~` in a user-entered override path, expanded to the home directory. */
const LEADING_TILDE = /^~/;

/**
 * Persist a renderer-supplied CLI binary-path override patch and invalidate the
 * caches that memoize a resolved binary.
 *
 * Each non-null value is `~`-expanded, required to be absolute, resolved through
 * `realpath` to its canonical target, and checked for the execute bit BEFORE it
 * is persisted — so a later swap of an intermediate symlink cannot redirect
 * future spawns, and a compromised renderer cannot point claude/gh/codex at a
 * non-executable or unintended path. Throws (rejecting the whole patch) on the
 * first invalid entry.
 */
export function applyBinaryPathPatchAndInvalidateCaches(
  settingsStore: SettingsStore,
  patch: BinaryPathPatch
): Partial<Record<CliBinaryTool, string>> {
  const expandedPatch: BinaryPathPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    const typedKey = key as CliBinaryTool;
    if (value === null || value === undefined) {
      expandedPatch[typedKey] = value;
      continue;
    }
    expandedPatch[typedKey] = resolveExecutableOverride(key, value);
  }
  const updated = settingsStore.patchBinaryPaths(
    expandedPatch as Record<string, string | null>
  );
  resetResolvedClaudePath();
  resetMcpDetectionCache();
  return updated;
}

/**
 * Canonicalize one override value, or throw a message naming the offending tool.
 * The renderer surfaces the thrown message directly.
 */
function resolveExecutableOverride(key: string, value: string): string {
  const expanded = value.replace(LEADING_TILDE, os.homedir());
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `Binary path for ${key} must be an absolute path: ${value}`
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(expanded);
  } catch {
    throw new Error(`Binary path for ${key} does not exist: ${value}`);
  }
  try {
    accessSync(resolved, fsConstants.X_OK);
  } catch {
    throw new Error(`Binary path for ${key} is not executable: ${value}`);
  }
  return resolved;
}
