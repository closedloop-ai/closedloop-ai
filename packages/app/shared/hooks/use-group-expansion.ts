"use client";

import { useCallback, useMemo } from "react";

import { useOptionalPersistedState } from "./use-optional-persisted-state";

const GROUP_EXPANSION_STORAGE_VERSION = 1;
export const GROUP_EXPANSION_STORAGE_LIMIT = 500;

type GroupExpansionStorage =
  | string[]
  | { version: typeof GROUP_EXPANSION_STORAGE_VERSION; toggledKeys: string[] };

/**
 * Hook managing which groups are expanded/collapsed in a grouped table view.
 * Persists toggled groups to localStorage so state survives re-renders,
 * data refetches, and page navigation.
 *
 * @param storageKey - localStorage key for persisting state, or `null` to hold
 *   the state in memory and persist nothing. ISS-9726: a group key can be an
 *   org-scoped entity id, so while the owning organization is unresolved there
 *   is no key this value can honestly be written under.
 * @param options.defaultExpanded - When true, groups default to expanded and
 *   the stored keys represent *collapsed* groups. Default: false (collapsed).
 */
export function useGroupExpansion(
  storageKey: string | null,
  options?: { defaultExpanded?: boolean }
) {
  const defaultExpanded = options?.defaultExpanded ?? false;
  const [storedExpansion, setStoredExpansion] =
    useOptionalPersistedState<GroupExpansionStorage>(
      storageKey,
      NO_TOGGLED_KEYS,
      validateGroupExpansionStorage
    );
  const toggledKeys = useMemo(
    () => boundedExpansionKeys(storedExpansion),
    [storedExpansion]
  );

  const toggledSet = useMemo(() => new Set(toggledKeys), [toggledKeys]);

  const isExpanded = useCallback(
    (groupKey: string) =>
      defaultExpanded ? !toggledSet.has(groupKey) : toggledSet.has(groupKey),
    [toggledSet, defaultExpanded]
  );

  const toggleGroup = useCallback(
    (groupKey: string) => {
      setStoredExpansion((previous) => {
        const set = new Set(boundedExpansionKeys(previous));
        if (set.has(groupKey)) {
          set.delete(groupKey);
        } else {
          set.add(groupKey);
        }
        return versionedExpansion(Array.from(set));
      });
    },
    [setStoredExpansion]
  );

  const pruneGroups = useCallback(
    (validKeys: ReadonlySet<string>) => {
      setStoredExpansion((previous) => {
        const previousKeys = boundedExpansionKeys(previous);
        const next = previousKeys.filter((key) => validKeys.has(key));
        return next.length === previousKeys.length && !Array.isArray(previous)
          ? previous
          : versionedExpansion(next);
      });
    },
    [setStoredExpansion]
  );

  const setToggledGroups = useCallback(
    (keys: readonly string[]) => setStoredExpansion(versionedExpansion(keys)),
    [setStoredExpansion]
  );

  return {
    isExpanded,
    pruneGroups,
    setToggledGroups,
    toggledKeys,
    toggleGroup,
  };
}

const NO_TOGGLED_KEYS = versionedExpansion([]);

function validateGroupExpansionStorage(
  value: unknown,
  fallback: GroupExpansionStorage
): GroupExpansionStorage {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string") ? value : fallback;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "version" in value &&
    value.version === GROUP_EXPANSION_STORAGE_VERSION &&
    "toggledKeys" in value &&
    Array.isArray(value.toggledKeys) &&
    value.toggledKeys.every((entry) => typeof entry === "string")
  ) {
    return value as GroupExpansionStorage;
  }
  return fallback;
}

function boundedExpansionKeys(value: GroupExpansionStorage): string[] {
  const keys = Array.isArray(value) ? value : value.toggledKeys;
  return [...new Set(keys)].slice(-GROUP_EXPANSION_STORAGE_LIMIT);
}

function versionedExpansion(keys: readonly string[]): GroupExpansionStorage {
  return {
    toggledKeys: [...new Set(keys)].slice(-GROUP_EXPANSION_STORAGE_LIMIT),
    version: GROUP_EXPANSION_STORAGE_VERSION,
  };
}

/** Namespace every group-expansion key shares. */
export const GROUP_EXPANSION_KEY_PREFIX = "table:expand:" as const;

/**
 * A group-expansion key from a caller's base, or `null` when the base is `null`
 * (ISS-9726: nothing to persist under yet). Propagating the `null` rather than
 * interpolating it is the point — `table:expand:null-group-sections` would be a
 * real key shared by every organization.
 */
export function groupExpansionKey(
  base: string | null,
  suffix: string
): string | null {
  if (base === null) {
    return null;
  }
  return `${GROUP_EXPANSION_KEY_PREFIX}${base}${suffix}`;
}
