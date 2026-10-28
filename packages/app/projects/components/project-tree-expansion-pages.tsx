"use client";

import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  hierarchyExpansionParentIds,
  mergeProjectTreeExpansionPages,
} from "../../documents/lib/project-hierarchy-child-pages";
import { useManualArtifactOrderingEnabled } from "../../shared/feature-flags/use-manual-artifact-ordering";
import { useProjectArtifactHierarchyExpansion } from "../hooks/use-project-artifact-hierarchy-expansion";
import {
  projectTreeExpansionParentIds,
  useProjectTreeExpansionBatch,
} from "../hooks/use-project-tree";

export const ProjectTreeChildLoadState = {
  Error: "error",
  Loading: "loading",
  Loaded: "loaded",
} as const;
export type ProjectTreeChildLoadState =
  (typeof ProjectTreeChildLoadState)[keyof typeof ProjectTreeChildLoadState];

/** Query state for one opened parent; retries re-run only its own child read. */
export type ProjectTreeChildLoad = {
  state: ProjectTreeChildLoadState;
  retry: () => void;
};

/**
 * Resolves opened child continuations and each opened parent's load state,
 * without adding a query (or the API client it needs) to a list nothing opened.
 */
export function useProjectTreeExpansionState(
  projectId: string,
  tree: ProjectTreeDetailsResponse | undefined,
  expandedArtifactIds: ReadonlySet<string>
) {
  const enabled = useManualArtifactOrderingEnabled();
  const parentArtifactIds = useMemo(
    () =>
      enabled
        ? hierarchyExpansionParentIds(tree, (id) => expandedArtifactIds.has(id))
        : [],
    [enabled, expandedArtifactIds, tree]
  );
  const [pageState, setPageState] =
    useState<ExpansionPagesState>(EMPTY_PAGE_STATE);
  const retries = useRef<ReadonlyMap<string, () => void>>(new Map());
  const current = sameIds(pageState.parentArtifactIds, parentArtifactIds)
    ? pageState
    : EMPTY_PAGE_STATE;
  const expandedTree = useMemo(() => {
    if (!tree) {
      return undefined;
    }
    return enabled && current.pages.length > 0
      ? mergeProjectTreeExpansionPages(tree, current.pages)
      : tree;
  }, [current.pages, enabled, tree]);
  const childLoadByParentId = useMemo(
    () =>
      new Map(
        current.loadStates.map(
          ([parentId, state]): [string, ProjectTreeChildLoad] => [
            parentId,
            { state, retry: () => retries.current.get(parentId)?.() },
          ]
        )
      ),
    [current.loadStates]
  );
  const expansionLoader =
    parentArtifactIds.length > 0 ? (
      <ProjectTreeExpansionPages
        onPages={setPageState}
        parentArtifactIds={parentArtifactIds}
        projectId={projectId}
        retries={retries}
      />
    ) : null;
  return { childLoadByParentId, expandedTree, expansionLoader };
}

/**
 * The Project tree's expansion and child loading. Under manual ordering the
 * bounded, versioned, link-restorable owner holds expansion (ISS-12929 726-F5)
 * and each opened parent reports its child-page state (726-F6); flag off keeps
 * the generic view's own stored expansion, as main has it.
 */
export function useProjectHierarchyLoading(
  projectId: string,
  tree: ProjectTreeDetailsResponse | undefined,
  persistenceKey: string | null
) {
  const enabled = useManualArtifactOrderingEnabled();
  const storageKey = persistenceKey ? `${persistenceKey}:expansion` : null;
  const [viewExpandedIds, setViewExpandedIds] =
    useState<ReadonlySet<string>>(NO_EXPANDED_IDS);
  const bounded = useProjectArtifactHierarchyExpansion(
    enabled ? storageKey : null,
    enabled ? tree : undefined
  );
  const { childLoadByParentId, expandedTree, expansionLoader } =
    useProjectTreeExpansionState(
      projectId,
      tree,
      enabled ? bounded.expandedArtifactIds : viewExpandedIds
    );
  const expansion = enabled
    ? { controlledExpansion: bounded.controlledExpansion }
    : { onExpandedChange: setViewExpandedIds, expansionStorageKey: storageKey };
  return { childLoadByParentId, expandedTree, expansion, expansionLoader };
}

/** Loads bounded child-page continuations only when a hierarchy parent opens. */
export function ProjectTreeExpansionPages({
  onPages,
  parentArtifactIds,
  projectId,
  retries,
}: {
  onPages: Dispatch<SetStateAction<ExpansionPagesState>>;
  parentArtifactIds: readonly string[];
  projectId: string;
  retries: { current: ReadonlyMap<string, () => void> };
}) {
  const queries = useProjectTreeExpansionBatch(projectId, parentArtifactIds);
  const orderedParentIds = projectTreeExpansionParentIds(parentArtifactIds);
  retries.current = new Map(
    orderedParentIds.flatMap((parentId, index): [string, () => void][] => {
      const query = queries[index];
      return query
        ? [
            [
              parentId,
              () => {
                query.refetch();
              },
            ],
          ]
        : [];
    })
  );
  const pages = queries.flatMap((query) => (query.data ? [query.data] : []));
  const loadStates = orderedParentIds.flatMap(
    (parentId, index): [string, ProjectTreeChildLoadState][] => {
      const query = queries[index];
      return query ? [[parentId, childLoadState(query)]] : [];
    }
  );
  useEffect(() => {
    onPages((previous) =>
      sameIds(previous.parentArtifactIds, parentArtifactIds) &&
      previous.pages.length === pages.length &&
      previous.pages.every((page, index) => page === pages[index]) &&
      previous.loadStates.length === loadStates.length &&
      previous.loadStates.every(
        ([parentId, state], index) =>
          loadStates[index]?.[0] === parentId &&
          loadStates[index]?.[1] === state
      )
        ? previous
        : { loadStates, pages, parentArtifactIds }
    );
  }, [loadStates, onPages, pages, parentArtifactIds]);
  return null;
}

type ExpansionPagesState = {
  loadStates: readonly [string, ProjectTreeChildLoadState][];
  pages: ProjectTreeDetailsResponse[][];
  parentArtifactIds: readonly string[];
};

const NO_EXPANDED_IDS: ReadonlySet<string> = new Set();

const EMPTY_PAGE_STATE: ExpansionPagesState = {
  loadStates: [],
  pages: [],
  parentArtifactIds: [],
};

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function childLoadState(query: {
  isError?: boolean;
  isPending?: boolean;
}): ProjectTreeChildLoadState {
  if (query.isError) {
    return ProjectTreeChildLoadState.Error;
  }
  if (query.isPending) {
    return ProjectTreeChildLoadState.Loading;
  }
  return ProjectTreeChildLoadState.Loaded;
}
