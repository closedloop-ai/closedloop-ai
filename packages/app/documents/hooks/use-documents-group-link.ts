"use client";

import { useGroupBy } from "@repo/app/documents/hooks/use-group-by";
import {
  collapsedGroupsFromLegacySections,
  documentsGroupingState,
  LEGACY_GROUP_SECTIONS_KEY_SUFFIX,
  readDocumentsGroupLink,
} from "@repo/app/documents/lib/documents-group-link";
import type { GroupByMode } from "@repo/app/documents/lib/group-by";
import { useAuthoritativeSearchParams } from "@repo/app/shared/hooks/use-authoritative-search-params";
import { groupExpansionKey } from "@repo/app/shared/hooks/use-group-expansion";
import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { useOptionalPersistedState } from "@repo/app/shared/hooks/use-optional-persisted-state";
import { stringMembersOrEmpty } from "@repo/app/shared/lib/local-storage-validators";
import {
  overlayLinkedCollapsedGroups,
  PERSISTED_COLLAPSED_GROUPS_SCHEMA,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { writeTableGroupViewParams } from "@repo/app/shared/lib/table-group-view-params";
import {
  useInertNavigation,
  useNoPath,
  useNoSearchParams,
} from "@repo/navigation/inert-navigation";
import { useNavigationAdapterOptional } from "@repo/navigation/provider";
import { useCallback, useMemo, useRef } from "react";

/**
 * PRD-720 AC3 on the project board: the grouping and the closed bands a reader
 * sees, carried in the URL so a refresh and a shared link restore them.
 *
 * The same precedence Branches uses (`useBranchGroupViewUrlState`): a link
 * states the view it was copied from, so it wins over the recipient's stored
 * view for as long as the URL says it, and it is DERIVED from the URL each
 * render, so Back, Forward and a second link to the same route restore what
 * they name. Stating is not persisting: the link reaches the reader's stored
 * view only when they change the grouping or a band, and that gesture stores and
 * links the whole view they are looking at. A URL that names no grouping shows
 * the stored view, as it always has.
 *
 * Collapse is keyed per grouping axis (`TableCollapsedGroups`), so a band
 * closed under Status stays open under Priority.
 */
export function useDocumentsGroupLink({
  expansionStorageKey,
  groupByStorageKey,
}: {
  /**
   * The owner's group-expansion base key; `null` holds collapse in memory until
   * it resolves (ISS-9726).
   */
  expansionStorageKey: string | null;
  groupByStorageKey: string;
}): DocumentsGroupLinkState {
  const { groupBy: storedGroupBy, setGroupBy: storeGroupBy } =
    useGroupBy(groupByStorageKey);
  // The flat record the board kept before collapse was per axis. It stands in
  // for the per-axis record until that record is first written, so a band a
  // reader had closed does not reopen when this ships.
  const [legacySections] = useOptionalPersistedState<string[]>(
    groupExpansionKey(expansionStorageKey, LEGACY_GROUP_SECTIONS_KEY_SUFFIX),
    NO_LEGACY_SECTIONS,
    stringMembersOrEmpty
  );
  const carriedCollapsed = useMemo(
    () => collapsedGroupsFromLegacySections(legacySections),
    [legacySections]
  );
  const [storedCollapsed, storeCollapsed] =
    useOptionalPersistedState<TableCollapsedGroups>(
      groupExpansionKey(expansionStorageKey, COLLAPSED_GROUPS_KEY_SUFFIX),
      carriedCollapsed,
      parseStoredCollapsedGroups
    );
  const adapter = useNavigationAdapterOptional();
  const readPath = adapter?.usePathValue ?? useNoPath;
  const readParams = adapter?.useSearchParamsSnapshot ?? useNoSearchParams;
  const readNavigation = adapter?.useNavigationActions ?? useInertNavigation;
  const path = readPath();
  const params = useAuthoritativeSearchParams(readParams(), path);
  const navigation = readNavigation();
  const { readLatest, replaceSearch } = useLinkedSearchWriter(
    path,
    params,
    navigation.replace
  );

  const linked = useMemo(() => readDocumentsGroupLink(params), [params]);
  const groupBy = linked?.groupBy ?? storedGroupBy;
  const collapsedGroups = useMemo(
    () =>
      linked
        ? overlayLinkedCollapsedGroups(storedCollapsed, linked)
        : storedCollapsed,
    [linked, storedCollapsed]
  );

  // Assigned every render, so two gestures inside one event each start from
  // what the previous one decided rather than from this render's snapshot.
  const latest = useRef({ collapsedGroups, groupBy });
  latest.current = { collapsedGroups, groupBy };

  const commit = useCallback(
    (nextGroupBy: GroupByMode, nextCollapsed: TableCollapsedGroups) => {
      const next = readLatest();
      writeTableGroupViewParams(
        next,
        documentsGroupingState(nextGroupBy),
        nextCollapsed
      );
      latest.current = {
        collapsedGroups: nextCollapsed,
        groupBy: nextGroupBy,
      };
      storeGroupBy(nextGroupBy);
      storeCollapsed(nextCollapsed);
      replaceSearch(next);
    },
    [readLatest, replaceSearch, storeCollapsed, storeGroupBy]
  );

  const setGroupBy = useCallback(
    (next: GroupByMode) => commit(next, latest.current.collapsedGroups),
    [commit]
  );
  const setCollapsedGroups = useCallback(
    (next: TableCollapsedGroups) => commit(latest.current.groupBy, next),
    [commit]
  );

  return { collapsedGroups, groupBy, setCollapsedGroups, setGroupBy };
}

/** What the project board reads and writes for its grouping and band collapse. */
export type DocumentsGroupLinkState = {
  collapsedGroups: TableCollapsedGroups;
  groupBy: GroupByMode;
  setCollapsedGroups: (next: TableCollapsedGroups) => void;
  setGroupBy: (next: GroupByMode) => void;
};

function parseStoredCollapsedGroups(value: unknown): TableCollapsedGroups {
  return PERSISTED_COLLAPSED_GROUPS_SCHEMA.parse(value);
}

/**
 * Its own key beside the view's `-group-sections` expansion: that record is a
 * flat key list with no axis, so a per-axis record cannot share its slot.
 */
const COLLAPSED_GROUPS_KEY_SUFFIX = "-collapsed-groups";

const NO_LEGACY_SECTIONS: string[] = [];
