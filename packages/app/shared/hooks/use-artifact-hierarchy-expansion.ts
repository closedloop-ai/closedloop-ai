"use client";

import { useAuthoritativeSearchParams } from "@repo/app/shared/hooks/use-authoritative-search-params";
import { useGroupExpansion } from "@repo/app/shared/hooks/use-group-expansion";
import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { HIERARCHY_EXPANDED_PARAM } from "@repo/app/shared/lib/hierarchy-expanded-param";
import {
  useInertNavigation,
  useNoPath,
  useNoSearchParams,
} from "@repo/navigation/inert-navigation";
import { useNavigationAdapterOptional } from "@repo/navigation/provider";
import { useCallback, useMemo, useRef } from "react";

/**
 * Shared bounded, versioned, URL-aware hierarchy expansion owner. A linked set
 * is authoritative until a reader gesture persists the resulting set locally.
 */
export function useArtifactHierarchyExpansion(
  storageKey: string | null,
  linkedExpansionEnabled = false
) {
  const {
    isExpanded: isStoredExpanded,
    setToggledGroups,
    toggledKeys,
  } = useGroupExpansion(storageKey);
  const adapter = useNavigationAdapterOptional();
  const readPath = adapter?.usePathValue ?? useNoPath;
  const readParams = adapter?.useSearchParamsSnapshot ?? useNoSearchParams;
  const readNavigation = adapter?.useNavigationActions ?? useInertNavigation;
  const path = readPath();
  const params = useAuthoritativeSearchParams(readParams(), path);
  const navigation = readNavigation();
  const { readLatest, replaceSearch, search } = useLinkedSearchWriter(
    path,
    params,
    navigation.replace
  );
  // The query to read from is the one this reader last wrote while the router
  // has not reflected it yet, not the stale snapshot: reading the snapshot would
  // show the previous set again and make an owner that re-asserts the set
  // re-commit on every render.
  const linkedKeys = useMemo(
    () =>
      linkedExpansionEnabled
        ? readLinkedExpansion(new URLSearchParams(search))
        : null,
    [linkedExpansionEnabled, search]
  );
  // A link this reader wrote carries only the newest keys that fit the URL
  // budget; while it still matches the stored set, the stored set (up to 500)
  // is what is open. Any other link is authoritative as given.
  const ownLink =
    linkedKeys !== null &&
    sameKeys(linkedKeys, keysWithinUrlBudget(toggledKeys ?? []));
  const expandedKeys =
    (ownLink ? toggledKeys : linkedKeys) ?? toggledKeys ?? [];
  const expandedSet = useMemo(() => new Set(expandedKeys), [expandedKeys]);

  const latest = useRef({ expandedKeys, linked: linkedKeys !== null });
  latest.current = { expandedKeys, linked: linkedKeys !== null };

  const commit = useCallback(
    (nextKeys: readonly string[]) => {
      const boundedKeys = boundedValidKeys(nextKeys);
      if (!linkedExpansionEnabled) {
        latest.current = { expandedKeys: boundedKeys, linked: false };
        setToggledGroups(boundedKeys);
        return;
      }
      const next = readLatest();
      next.delete(HIERARCHY_EXPANDED_PARAM);
      if (boundedKeys.length === 0) {
        next.append(HIERARCHY_EXPANDED_PARAM, "");
      } else {
        for (const key of keysWithinUrlBudget(boundedKeys).sort()) {
          next.append(HIERARCHY_EXPANDED_PARAM, key);
        }
      }
      // The same set already stored and already in the URL: committing again
      // would only re-render the owner, which re-commits, until the router
      // reflects the first write.
      if (
        sameKeys(boundedKeys, latest.current.expandedKeys) &&
        next.toString() === readLatest().toString()
      ) {
        return;
      }
      latest.current = { expandedKeys: boundedKeys, linked: true };
      setToggledGroups(boundedKeys);
      replaceSearch(next);
    },
    [linkedExpansionEnabled, readLatest, replaceSearch, setToggledGroups]
  );

  const isExpanded = useCallback(
    (artifactId: string) =>
      linkedKeys === null || ownLink
        ? isStoredExpanded(artifactId)
        : expandedSet.has(artifactId),
    [expandedSet, isStoredExpanded, linkedKeys, ownLink]
  );
  const toggleGroup = useCallback(
    (artifactId: string) => {
      const next = new Set(latest.current.expandedKeys);
      if (next.has(artifactId)) {
        next.delete(artifactId);
      } else if (isValidArtifactId(artifactId)) {
        next.add(artifactId);
      }
      commit([...next]);
    },
    [commit]
  );
  const pruneGroups = useCallback(
    (validKeys: ReadonlySet<string>) => {
      const next = latest.current.expandedKeys.filter((key) =>
        validKeys.has(key)
      );
      if (next.length === latest.current.expandedKeys.length) {
        return;
      }
      if (latest.current.linked) {
        commit(next);
      } else {
        setToggledGroups(next);
      }
    },
    [commit, setToggledGroups]
  );

  const setExpandedIds = useCallback(
    (ids: ReadonlySet<string>) => commit([...ids]),
    [commit]
  );

  return { expandedSet, isExpanded, pruneGroups, setExpandedIds, toggleGroup };
}

function readLinkedExpansion(
  params: Pick<URLSearchParams, "toString">
): string[] | null {
  const source = new URLSearchParams(params.toString());
  if (!source.has(HIERARCHY_EXPANDED_PARAM)) {
    return null;
  }
  return boundedValidKeys(source.getAll(HIERARCHY_EXPANDED_PARAM));
}

function boundedValidKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter(isValidArtifactId))].slice(
    -MAX_LINKED_EXPANSION_KEYS
  );
}

function isValidArtifactId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ARTIFACT_ID_LENGTH;
}

const MAX_LINKED_EXPANSION_KEYS = 500;
const MAX_ARTIFACT_ID_LENGTH = 256;

/**
 * The newest keys whose repeated query parameters stay under the URL budget
 * Daveth set on #9143 (8 KB, about 145 artifact IDs); the stored set keeps up
 * to 500. A reloaded or shared link past that budget fails server-side.
 */
function keysWithinUrlBudget(keys: readonly string[]): string[] {
  const kept: string[] = [];
  let length = 0;
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index] ?? "";
    const entryLength =
      HIERARCHY_EXPANDED_PARAM.length + encodeURIComponent(key).length + 2;
    if (length + entryLength > MAX_LINKED_EXPANSION_QUERY_LENGTH) {
      break;
    }
    length += entryLength;
    kept.push(key);
  }
  return kept.reverse();
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  const rightKeys = new Set(right);
  return (
    left.length === rightKeys.size && left.every((key) => rightKeys.has(key))
  );
}

const MAX_LINKED_EXPANSION_QUERY_LENGTH = 8000;
