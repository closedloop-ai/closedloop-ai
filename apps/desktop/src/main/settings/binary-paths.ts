/**
 * The resolved-binary path maps persisted under `binaryPaths`, plus pure
 * helpers for preserving or deleting legacy persisted keys while exposing only
 * current tools to Settings surfaces.
 */

import type {
  CurrentBinaryPaths as FilteredBinaryPaths,
  BinaryPaths as PersistedBinaryPaths,
  PersistedCliBinaryTool,
} from "../../shared/cli-binary-tools.js";
import {
  CliBinaryToolKeyStatus,
  classifyCliBinaryToolKey,
  isCurrentCliBinaryTool,
} from "../../shared/cli-binary-tools.js";

export type {
  BinaryPaths,
  CurrentBinaryPaths,
} from "../../shared/cli-binary-tools.js";

/**
 * Applies a current-tool `path | null` patch onto the persisted binary-path map.
 * Legacy persisted keys are preserved and may be deleted, but cannot be added or
 * changed here.
 */
export function mergeBinaryPaths(
  current: PersistedBinaryPaths,
  patch: Record<string, string | null | undefined>
): PersistedBinaryPaths {
  const merged = filterPersistedBinaryPaths(current);
  for (const [key, value] of Object.entries(patch)) {
    const status = classifyCliBinaryToolKey(key);
    if (status === CliBinaryToolKeyStatus.Unknown) {
      continue;
    }
    if (status === CliBinaryToolKeyStatus.Legacy) {
      if (value === null && isPersistedBinaryPathKey(key)) {
        delete merged[key];
      }
      continue;
    }
    if (!isCurrentCliBinaryTool(key)) {
      continue;
    }
    if (value === null) {
      delete merged[key];
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function filterPersistedBinaryPaths(
  paths: PersistedBinaryPaths | undefined
): PersistedBinaryPaths {
  const filtered: PersistedBinaryPaths = {};
  for (const [key, value] of Object.entries(paths ?? {})) {
    if (isPersistedBinaryPathKey(key) && typeof value === "string") {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function filterCurrentBinaryPaths(
  paths: PersistedBinaryPaths | undefined
): FilteredBinaryPaths {
  const filtered: FilteredBinaryPaths = {};
  for (const [key, value] of Object.entries(paths ?? {})) {
    if (isCurrentCliBinaryTool(key) && typeof value === "string") {
      filtered[key] = value;
    }
  }
  return filtered;
}

function isPersistedBinaryPathKey(key: string): key is PersistedCliBinaryTool {
  return classifyCliBinaryToolKey(key) !== CliBinaryToolKeyStatus.Unknown;
}
