"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { useAuthoritativeSearchParams } from "@repo/app/shared/hooks/use-authoritative-search-params";
import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { WEB_SHELL_ROUTE_HREFS } from "@repo/app/shared/lib/primary-nav-destinations";
import { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";
import {
  TABLE_COLLAPSED_GROUP_PARAM,
  type TableCollapsedGroups,
  tableGroupCollapsePort,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  readTableGroupViewParams,
  TABLE_GROUP_EMPTY_PARAM,
  TABLE_GROUP_PARAM,
  writeTableGroupViewParams,
} from "@repo/app/shared/lib/table-group-view-params";
import type {
  TableFieldOption,
  TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import {
  useInertNavigation,
  useNoPath,
  useNoSearchParams,
} from "@repo/navigation/inert-navigation";
import { useNavigationAdapterOptional } from "@repo/navigation/provider";
import { useEffect, useRef, useState } from "react";
import type {
  SessionsListViewPatch,
  SessionsListViewState,
} from "../components/sessions/sessions-list-view-state";
import { SESSION_URL_OWNED_WINDOW_PARAMS } from "../lib/session-custom-date-window";
import { writeSessionFacetFilterParams } from "../lib/session-filter-adapter";
import {
  parseSessionsPageIndex,
  SESSIONS_PAGE_PARAM,
} from "../lib/session-pagination";
import {
  SESSIONS_SEARCH_PARAM,
  SESSIONS_SELECTED_USER_PARAM,
} from "../lib/session-url-scope-params";

/** Sessions links own full grouping/collapse; isolated mounts retain the same in-memory interaction. */
export function useSessionsGroupLink({
  grouping,
  groupOptions,
  groups,
  updateView,
  view,
}: {
  grouping: TableGroupingState;
  groupOptions: readonly TableFieldOption[];
  groups: readonly GridTableV2Group<SessionTableRow>[] | undefined;
  updateView: (patch: SessionsListViewPatch) => void;
  view?: SessionsListViewState;
}) {
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
  const [collapsedGroups, setCollapsedGroups] = useState<TableCollapsedGroups>(
    {}
  );
  const [restored, setRestored] = useState(false);
  // The raw link the URL carried when this hook last read it. A link is only
  // read again when the URL's group, empty-group or collapsed values change, so
  // an unrelated write (a page, a facet) never re-applies a link.
  const observedLink = useRef<string | null>(null);
  // The raw link the reader last took from the URL. A router replace lands
  // asynchronously, so until this hook's own write reaches the URL the params
  // still carry a link already consumed; a re-render in that window (a
  // selection reconcile after a collapse) must not restore it as an outside
  // change (ISS-12640).
  const consumedLink = useRef<string | null>(null);
  // A restored grouping waits ONE render for the host to adopt it, then the
  // write below compares what is actually rendered against the link.
  const pendingGrouping = useRef<PendingGrouping | null>(null);
  const lastLinkedState = useRef<string | null>(null);
  const isSessionsRoute = path.endsWith(SESSIONS_ROUTE_PATH);
  const scope = groupLinkScope(view);
  const observedScope = useRef({ scope, params: params.toString() });
  const pendingScopeParams = useRef<string | null>(null);
  const ownsLinkedState = useRef(false);

  useEffect(() => {
    if (!isSessionsRoute) {
      return;
    }
    const rawLink = rawGroupLink(params);
    if (observedLink.current === rawLink || consumedLink.current === rawLink) {
      consumedLink.current = rawLink;
      return;
    }
    const linked = readSessionsGroupLink(params, groupOptions);
    if (linked === null) {
      // A level this mount cannot honour yet (a custom field whose options have
      // not loaded) stays unobserved, so the next options change retries it.
      if (params.getAll(TABLE_GROUP_PARAM).length === 0) {
        observedLink.current = rawLink;
        consumedLink.current = rawLink;
      }
      lastLinkedState.current ??= groupLinkState(grouping, collapsedGroups);
      setRestored(true);
      return;
    }
    observedLink.current = rawLink;
    consumedLink.current = rawLink;
    ownsLinkedState.current = true;
    const linkedState = groupLinkState(linked.grouping, linked.collapsedGroups);
    // Equal to the last state this hook linked or wrote: its own write coming
    // back, or a link that already says what is on screen. Anything else came
    // from outside (a shared link, a same-route link, Back or Forward) and is
    // restored, whichever route the reader was on before.
    if (linkedState !== lastLinkedState.current) {
      lastLinkedState.current = linkedState;
      setCollapsedGroups(linked.collapsedGroups);
      if (!sameGrouping(linked.grouping, grouping)) {
        pendingGrouping.current = { replaced: grouping, waited: false };
        updateView({ grouping: linked.grouping });
      }
    }
    setRestored(true);
  }, [
    collapsedGroups,
    groupOptions,
    grouping,
    isSessionsRoute,
    params,
    updateView,
  ]);

  useEffect(() => {
    if (!(isSessionsRoute && restored)) {
      return;
    }
    if (holdForRestoredGrouping(pendingGrouping, grouping)) {
      return;
    }
    const currentParams = params.toString();
    const previousScope = observedScope.current;
    observedScope.current = { scope, params: currentParams };
    if (
      previousScope.params === currentParams &&
      scopeRequiresUrlCommit(previousScope.scope, scope, params)
    ) {
      pendingScopeParams.current = currentParams;
    }
    if (pendingScopeParams.current === currentParams) {
      return;
    }
    pendingScopeParams.current = null;
    const state = groupLinkState(grouping, collapsedGroups);
    if (
      !groupLinkNeedsWrite(
        state,
        lastLinkedState.current,
        ownsLinkedState.current,
        params,
        groupOptions
      )
    ) {
      return;
    }
    if (
      view &&
      parseSessionsPageIndex(params.get(SESSIONS_PAGE_PARAM)) !== view.page
    ) {
      return;
    }
    const next = readLatest();
    writeTableGroupViewParams(next, grouping, collapsedGroups, true);
    ownsLinkedState.current = true;
    lastLinkedState.current = state;
    observedLink.current = rawGroupLink(next);
    replaceSearch(next);
  }, [
    collapsedGroups,
    grouping,
    groupOptions,
    isSessionsRoute,
    params,
    readLatest,
    replaceSearch,
    restored,
    scope,
    view,
  ]);

  return tableGroupCollapsePort({
    collapsedGroups,
    grouping,
    groups,
    isCompletePopulation: false,
    onCollapsedGroupsChange: setCollapsedGroups,
  });
}

/** The Sessions list route, as both shells spell its path. */
const SESSIONS_ROUTE_PATH =
  WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.Sessions];

function groupLinkState(
  grouping: TableGroupingState,
  collapsedGroups: Readonly<TableCollapsedGroups>
): string {
  const params = new URLSearchParams();
  writeTableGroupViewParams(params, grouping, collapsedGroups, true);
  return params.toString();
}

type GroupLinkScope = {
  facets: string;
  dateRange: SessionsListViewState["dateRange"] | undefined;
  scopeUserId: string | null | undefined;
  search: string | undefined;
};

function groupLinkScope(
  view: SessionsListViewState | undefined
): GroupLinkScope {
  const params = new URLSearchParams();
  if (view) {
    writeSessionFacetFilterParams(params, view.facets);
  }
  return {
    facets: params.toString(),
    dateRange: view?.dateRange,
    scopeUserId: view?.scopeUserId,
    search: view?.search,
  };
}

function scopeRequiresUrlCommit(
  previous: GroupLinkScope,
  next: GroupLinkScope,
  params: Pick<URLSearchParams, "has">
): boolean {
  if (previous.facets !== next.facets) {
    return true;
  }
  if (
    previous.dateRange !== next.dateRange &&
    SESSION_URL_OWNED_WINDOW_PARAMS.some((key) => params.has(key))
  ) {
    return true;
  }
  if (
    previous.scopeUserId !== next.scopeUserId &&
    next.scopeUserId === null &&
    params.has(SESSIONS_SELECTED_USER_PARAM)
  ) {
    return true;
  }
  return (
    previous.search !== next.search &&
    !next.search &&
    params.has(SESSIONS_SEARCH_PARAM)
  );
}

/** The grouping a restore replaced, held until the host renders past it. */
type PendingGrouping = {
  replaced: TableGroupingState;
  waited: boolean;
};

/**
 * Whether the write effect must wait for the host to render a restored
 * grouping. It holds only while the grouping it replaced is still the one on
 * screen, and for at most one render: the restore and this effect can run in the
 * same commit, before the host has seen the update. Once the host renders
 * anything else, adopted or narrowed, the pending grouping is cleared and the
 * write compares what is actually rendered, so a host that narrows a link never
 * leaves it waiting.
 */
function holdForRestoredGrouping(
  pending: { current: PendingGrouping | null },
  current: TableGroupingState
): boolean {
  const restoring = pending.current;
  if (restoring === null) {
    return false;
  }
  if (current === restoring.replaced && !restoring.waited) {
    restoring.waited = true;
    return true;
  }
  pending.current = null;
  return false;
}

function sameGrouping(
  left: TableGroupingState,
  right: TableGroupingState
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The URL values this hook owns, raw, so any change to them is noticed. */
function rawGroupLink(params: Pick<URLSearchParams, "getAll">): string {
  return JSON.stringify([
    params.getAll(TABLE_GROUP_PARAM),
    params.getAll(TABLE_GROUP_EMPTY_PARAM),
    params.getAll(TABLE_COLLAPSED_GROUP_PARAM),
  ]);
}

function readSessionsGroupLink(
  params: Pick<URLSearchParams, "getAll">,
  options: readonly TableFieldOption[]
) {
  const allowed = new Set(options.map((option) => option.id));
  return readTableGroupViewParams(params, (field) => allowed.has(field), true);
}

function groupLinkNeedsWrite(
  state: string,
  lastState: string | null,
  ownsState: boolean,
  params: Pick<URLSearchParams, "getAll">,
  options: readonly TableFieldOption[]
): boolean {
  if (state !== lastState) {
    return true;
  }
  if (!ownsState) {
    return false;
  }
  const linked = readSessionsGroupLink(params, options);
  return (
    linked === null ||
    state !== groupLinkState(linked.grouping, linked.collapsedGroups)
  );
}
