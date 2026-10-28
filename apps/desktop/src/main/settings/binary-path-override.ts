import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetResolvedClaudePath } from "../../server/operations/binary-path-overrides.js";
import {
  type CliBinaryTool,
  CliBinaryToolKeyStatus,
  classifyCliBinaryToolKey,
} from "../../shared/cli-binary-tools.js";
import type { BinaryPathPatch } from "../ipc/binary-paths-ipc.js";
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
 * future spawns, and a compromised renderer cannot point current tools at a
 * non-executable or unintended path. Throws (rejecting the whole patch) on the
 * first invalid entry.
 */
export function applyBinaryPathPatchAndInvalidateCaches(
  settingsStore: SettingsStore,
  patch: BinaryPathPatch
): Partial<Record<CliBinaryTool, string>> {
  const expandedPatch: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(patch)) {
    const keyStatus = classifyCliBinaryToolKey(key);
    if (keyStatus === CliBinaryToolKeyStatus.Unknown) {
      throw new Error(`Unknown binary path key: ${key}`);
    }
    if (keyStatus === CliBinaryToolKeyStatus.Legacy) {
      if (value === null) {
        expandedPatch[key] = null;
      }
      continue;
    }
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      expandedPatch[key] = value;
      continue;
    }
    expandedPatch[key] = resolveExecutableOverride(key, value);
  }
  const updated = settingsStore.patchBinaryPaths(expandedPatch);
  resetResolvedClaudePath();
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
