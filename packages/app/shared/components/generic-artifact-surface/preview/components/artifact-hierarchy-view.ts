"use client";

import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import {
  type HierarchyPlacementDirection,
  resolveHierarchyKeyboardPlacement,
} from "@repo/app/shared/lib/hierarchy-placement";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { GenericArtifact } from "../fixtures";
import {
  artifactParentIds,
  buildArtifactHierarchyForest,
  expansionAfterArtifactHierarchyMove,
  flattenVisibleArtifactHierarchy,
  groupVisibleHierarchyRowsByRoot,
  retainArtifactMatchesWithAncestors,
  sortArtifactHierarchyRoots,
  type VisibleArtifactHierarchyRow,
  type VisibleArtifactRootGroup,
} from "./artifact-hierarchy";

/**
 * ISS-6560 PJV-01..PJV-16. Hierarchy is a project-collection capability, not a
 * shared-list default: a homogeneous artifact list that opted out passes no
 * spec and keeps main's flat pipeline untouched.
 */
export type ArtifactHierarchySpec = {
  /** Levels rendered including the root. Four for Projects. */
  maxVisibleLevels: number;
  /** Defaults to the historical expanded state when omitted. */
  initiallyExpanded?: boolean;
  expansionStorageKey?: string | null;
  /** A host-owned expansion lifecycle supersedes this view's legacy storage. */
  controlledExpansion?: {
    expandedIds: ReadonlySet<string>;
    onChange: (expandedIds: ReadonlySet<string>) => void;
  };
  /** Reports expansion choices to a host that pages descendants on demand. */
  onExpandedChange?: (artifactIds: ReadonlySet<string>) => void;
};

export type ArtifactProjectMoveConfig = {
  currentProject: { id: string; label: string };
  destinations: readonly { id: string; label: string }[];
};

export type ArtifactHierarchyView = {
  /** Filter matches plus every ancestor needed to show their lineage. */
  collectionArtifacts: readonly GenericArtifact[];
  enabled: boolean;
  isExpanded: (artifactId: string) => boolean;
  maxLevels: number;
  /** Visible rows in depth-first order — the list surface's row source. */
  orderedArtifacts: GenericArtifact[];
  rootArtifacts: GenericArtifact[];
  rootGroups: VisibleArtifactRootGroup[];
  rowByArtifactId: Map<string, VisibleArtifactHierarchyRow>;
  rows: VisibleArtifactHierarchyRow[];
  /** Reconciles expansion after a structural move (ISS-6560 undo contract). */
  syncExpansionAfterMove: (
    artifacts: readonly GenericArtifact[],
    insideTargetId?: string
  ) => void;
  toggleExpanded: (artifactId: string) => void;
};

export type ArtifactManualMoveDirection = HierarchyPlacementDirection;

/**
 * Resolves a keyboard manual-ordering gesture to the drop it means, so the
 * keyboard path and a future pointer drag commit through one move function
 * rather than two orderings that can disagree.
 */
export function artifactManualMoveTarget(
  rows: readonly VisibleArtifactHierarchyRow[],
  artifactId: string,
  direction: ArtifactManualMoveDirection
): { placement: "after" | "before" | "inside"; targetId: string } | undefined {
  const placement = resolveHierarchyKeyboardPlacement(
    rows.map((row) => ({
      id: row.artifact.id,
      parentId: row.artifact.parentArtifactId ?? null,
      depth: row.depth,
    })),
    artifactId,
    direction
  );
  return placement
    ? {
        placement: placement.position,
        targetId: placement.targetArtifactId,
      }
    : undefined;
}

/**
 * Owns the whole hierarchy fold so the shell keeps one call site rather than a
 * dozen memos, and so `artifact-shells.tsx` stays under the file ceiling.
 */
export function useArtifactHierarchyView({
  artifacts,
  compareArtifacts,
  filteredArtifacts,
  filtersActive,
  hierarchy,
  sortActive,
}: {
  artifacts: readonly GenericArtifact[];
  compareArtifacts: (left: GenericArtifact, right: GenericArtifact) => number;
  filteredArtifacts: readonly GenericArtifact[];
  filtersActive: boolean;
  hierarchy?: ArtifactHierarchySpec;
  sortActive: boolean;
}): ArtifactHierarchyView {
  const enabled = hierarchy !== undefined;
  const maxLevels = hierarchy?.maxVisibleLevels ?? 0;
  const [storedExpandedIds, setStoredExpandedIds] = useViewStatePersistence<
    string[] | null
  >(hierarchy?.expansionStorageKey ?? null, null);
  const controlledExpansion = hierarchy?.controlledExpansion;
  const expandedArtifactIds = useMemo(
    () => controlledExpansion?.expandedIds ?? new Set(storedExpandedIds ?? []),
    [controlledExpansion?.expandedIds, storedExpandedIds]
  );
  useEffect(() => {
    hierarchy?.onExpandedChange?.(expandedArtifactIds);
  }, [expandedArtifactIds, hierarchy?.onExpandedChange]);
  const expandedIdsRef = useRef(expandedArtifactIds);
  expandedIdsRef.current = expandedArtifactIds;
  const setExpandedArtifactIds = useCallback(
    (update: SetStateAction<Set<string>>) => {
      const current = new Set(expandedIdsRef.current);
      const next = typeof update === "function" ? update(current) : update;
      if (
        (controlledExpansion || storedExpandedIds !== null) &&
        next.size === current.size &&
        [...next].every((id) => current.has(id))
      ) {
        return;
      }
      expandedIdsRef.current = next;
      if (controlledExpansion) {
        controlledExpansion.onChange(next);
        return;
      }
      const ids = [...next];
      setStoredExpandedIds(ids);
    },
    [controlledExpansion, setStoredExpandedIds, storedExpandedIds]
  );
  const preFilterExpansion = useRef<Set<string> | null>(null);

  const filtered = useMemo(
    () =>
      enabled && filtersActive
        ? retainArtifactMatchesWithAncestors(
            artifacts,
            new Set(filteredArtifacts.map((artifact) => artifact.id))
          )
        : { ancestorIds: new Set<string>(), artifacts: filteredArtifacts },
    [artifacts, enabled, filteredArtifacts, filtersActive]
  );

  // An empty loading render must not become an explicit choice to collapse every parent.
  useEffect(() => {
    if (!enabled || controlledExpansion || artifacts.length === 0) {
      return;
    }
    if (storedExpandedIds === null) {
      setExpandedArtifactIds(
        hierarchy?.initiallyExpanded === false
          ? new Set()
          : artifactParentIds(artifacts)
      );
    }
  }, [
    artifacts,
    controlledExpansion,
    enabled,
    hierarchy?.initiallyExpanded,
    storedExpandedIds,
    setExpandedArtifactIds,
  ]);

  // PJV: filtering opens matching paths; clearing restores the prior choices.
  useEffect(() => {
    if (!enabled || artifacts.length === 0) {
      return;
    }
    if (filtersActive) {
      setExpandedArtifactIds((current) => {
        preFilterExpansion.current ??= current;
        const next = new Set(current);
        for (const ancestorId of filtered.ancestorIds) {
          next.add(ancestorId);
        }
        return next;
      });
      return;
    }
    const restored = preFilterExpansion.current;
    preFilterExpansion.current = null;
    if (restored) {
      setExpandedArtifactIds(restored);
    }
  }, [
    artifacts.length,
    enabled,
    filtered.ancestorIds,
    filtersActive,
    setExpandedArtifactIds,
  ]);

  const forest = useMemo(() => {
    if (!enabled) {
      return [];
    }
    const built = buildArtifactHierarchyForest(filtered.artifacts);
    return sortActive
      ? sortArtifactHierarchyRoots(built, compareArtifacts)
      : built;
  }, [compareArtifacts, enabled, filtered.artifacts, sortActive]);

  const rows = useMemo(
    () =>
      enabled
        ? flattenVisibleArtifactHierarchy(
            forest,
            expandedArtifactIds,
            maxLevels
          )
        : [],
    [enabled, expandedArtifactIds, forest, maxLevels]
  );

  const toggleExpanded = useCallback(
    (artifactId: string) => {
      setExpandedArtifactIds((current) => {
        const next = new Set(current);
        if (next.has(artifactId)) {
          next.delete(artifactId);
        } else {
          next.add(artifactId);
        }
        return next;
      });
    },
    [setExpandedArtifactIds]
  );

  const syncExpansionAfterMove = useCallback(
    (nextArtifacts: readonly GenericArtifact[], insideTargetId?: string) => {
      setExpandedArtifactIds((current) =>
        expansionAfterArtifactHierarchyMove(
          nextArtifacts,
          current,
          insideTargetId
        )
      );
    },
    [setExpandedArtifactIds]
  );

  return {
    collectionArtifacts: filtered.artifacts,
    enabled,
    isExpanded: (artifactId: string) => expandedArtifactIds.has(artifactId),
    maxLevels,
    orderedArtifacts: rows.map((row) => row.artifact),
    rootArtifacts: forest.map((node) => node.artifact),
    rootGroups: groupVisibleHierarchyRowsByRoot(rows),
    rowByArtifactId: new Map(rows.map((row) => [row.artifact.id, row])),
    rows,
    syncExpansionAfterMove,
    toggleExpanded,
  };
}
