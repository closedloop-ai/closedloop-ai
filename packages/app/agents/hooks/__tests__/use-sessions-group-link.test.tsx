import type {
  SessionsListViewPatch,
  SessionsListViewState,
} from "@repo/app/agents/components/sessions/sessions-list-view-state";
import { useSessionsGroupLink } from "@repo/app/agents/hooks/use-sessions-group-link";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import {
  SESSIONS_OWNER_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { TABLE_COLLAPSED_GROUP_PARAM } from "@repo/app/shared/lib/table-collapsed-groups";
import { TABLE_GROUP_PARAM } from "@repo/app/shared/lib/table-group-view-params";
import {
  EMPTY_TABLE_GROUPING,
  type TableFieldOption,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { buildSubgroupKey } from "@repo/design-system/lib/grid-table-v2-rows";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import type { NavigationActions } from "@repo/navigation/navigation-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * PRD-720 slice 3 on Sessions: a grouped list's link carries its grouping and
 * collapsed bands, so a refresh or a recipient restores the same closed bands,
 * and a collapse the reader makes is written back to the link.
 */

const SESSIONS_PATH = "/acme/sessions";
const GROUP_OPTIONS: readonly TableFieldOption[] = [
  { id: SESSIONS_STATUS_COLUMN_ID, label: "Status" },
  { id: SESSIONS_OWNER_COLUMN_ID, label: "Owner" },
];
const BY_STATUS: TableGroupingState = {
  primary: {
    fieldId: SESSIONS_STATUS_COLUMN_ID,
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
  secondary: EMPTY_TABLE_GROUPING.secondary,
};
const BY_STATUS_THEN_OWNER: TableGroupingState = {
  ...BY_STATUS,
  secondary: {
    fieldId: SESSIONS_OWNER_COLUMN_ID,
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};
const BASE_VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  sortBy: null,
  sortDir: "asc",
  visibleColumnIds: new Set([SESSIONS_STATUS_COLUMN_ID]),
};

function band(
  key: string,
  subgroups?: readonly string[]
): GridTableV2Group<SessionTableRow> {
  return {
    items: [],
    key,
    label: key,
    subgroups: subgroups?.map((sub) => ({ items: [], key: sub, label: sub })),
  };
}

const BANDS = [band("Active", ["Alex"]), band("Done", ["Alex"])];

function renderGroupLink({
  grouping = EMPTY_TABLE_GROUPING,
  href,
  narrow = (next) => next,
}: {
  grouping?: TableGroupingState;
  href?: string;
  /** What a host keeps of a grouping it is handed. */
  narrow?: (next: TableGroupingState) => TableGroupingState;
}) {
  const navigation: MemoryNavigation | null = href
    ? createMemoryNavigation({ initialPath: href })
    : null;
  const updateViewSpy = vi.fn<(patch: SessionsListViewPatch) => void>();
  const wrapper = navigation
    ? ({ children }: { children: ReactNode }) => (
        <NavigationProvider adapter={navigation.adapter}>
          {children}
        </NavigationProvider>
      )
    : undefined;
  const rendered = renderHook(
    () => {
      const [view, setView] = useState<SessionsListViewState>({
        ...BASE_VIEW,
        grouping,
      });
      const updateView = useCallback((patch: SessionsListViewPatch) => {
        updateViewSpy(patch);
        setView((current) => {
          const next = { ...current, ...patch };
          return { ...next, grouping: narrow(next.grouping) };
        });
      }, []);
      const port = useSessionsGroupLink({
        grouping: view.grouping,
        groupOptions: GROUP_OPTIONS,
        groups: BANDS,
        updateView,
        view,
      });
      return { grouping: view.grouping, port };
    },
    { wrapper }
  );
  return { navigation, rendered, updateViewSpy };
}

function currentParams(navigation: MemoryNavigation | null): URLSearchParams {
  const href = navigation?.getCurrentHref() ?? "";
  return new URL(href, "http://localhost").searchParams;
}

describe("useSessionsGroupLink", () => {
  it("restores a linked grouping and its closed band for a fresh recipient", () => {
    const { navigation, rendered, updateViewSpy } = renderGroupLink({
      href: `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=status:asc&${TABLE_COLLAPSED_GROUP_PARAM}=Active`,
    });

    expect(updateViewSpy).toHaveBeenCalledWith({ grouping: BY_STATUS });
    expect(rendered.result.current.grouping).toEqual(BY_STATUS);
    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(true);
    expect(rendered.result.current.port?.isCollapsed("Done")).toBe(false);
    // The link already says what the view shows, so restoring it is no write.
    expect(navigation?.getHistory()).toHaveLength(1);
  });

  it("writes a collapsed band to the link and keeps unrelated parameters", () => {
    const { navigation, rendered } = renderGroupLink({
      grouping: BY_STATUS,
      href: `${SESSIONS_PATH}?ref=shared`,
    });

    act(() => {
      rendered.result.current.port?.setCollapsed("Active", true);
    });

    const params = currentParams(navigation);
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual(["status:asc"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["Active"]);
    expect(params.get("ref")).toBe("shared");
    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(true);
  });

  it("closes an owner under one status without closing it under another", () => {
    const { navigation, rendered } = renderGroupLink({
      grouping: BY_STATUS_THEN_OWNER,
      href: SESSIONS_PATH,
    });
    const activeAlex = buildSubgroupKey("Active", "Alex");

    act(() => {
      rendered.result.current.port?.setCollapsed(activeAlex, true);
    });

    expect(rendered.result.current.port?.isCollapsed(activeAlex)).toBe(true);
    expect(
      rendered.result.current.port?.isCollapsed(
        buildSubgroupKey("Done", "Alex")
      )
    ).toBe(false);
    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual([activeAlex]);
  });

  it.each([
    ["an unknown field", "bogus:asc"],
    ["an unknown order", "status:sideways"],
  ])("ignores a link naming %s", (_case, level) => {
    const { rendered, updateViewSpy } = renderGroupLink({
      href: `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=${level}&${TABLE_COLLAPSED_GROUP_PARAM}=Active`,
    });

    expect(updateViewSpy).not.toHaveBeenCalled();
    expect(rendered.result.current.grouping).toEqual(EMPTY_TABLE_GROUPING);
  });

  it("stops waiting after one render when the host narrows a restored grouping", () => {
    const { navigation, rendered } = renderGroupLink({
      href: `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=status:asc`,
      narrow: (next) => ({
        ...next,
        primary: { ...next.primary, order: TableGroupOrder.Custom },
      }),
    });

    expect(rendered.result.current.grouping.primary.order).toBe(
      TableGroupOrder.Custom
    );
    // The link now names the order that is rendered, not the one it asked for.
    expect(currentParams(navigation).getAll(TABLE_GROUP_PARAM)).toEqual([
      "status:custom",
    ]);

    act(() => {
      rendered.result.current.port?.setCollapsed("Active", true);
    });

    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual(["Active"]);
  });

  it("keeps collapse in memory when no navigation provider is mounted", () => {
    const hrefBefore = window.location.href;
    const { rendered } = renderGroupLink({ grouping: BY_STATUS });

    act(() => {
      rendered.result.current.port?.setCollapsed("Active", true);
    });

    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(true);
    expect(window.location.href).toBe(hrefBefore);
  });

  it("never writes the link from a route other than Sessions", () => {
    const { navigation, rendered } = renderGroupLink({
      grouping: BY_STATUS,
      href: "/acme/branches?ref=shared",
    });

    act(() => {
      rendered.result.current.port?.setCollapsed("Active", true);
    });

    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(true);
    expect(navigation?.getHistory()).toHaveLength(1);
  });

  it("keeps a collapse while its own URL write is still in flight", () => {
    const { navigation, pending, rendered } = renderWithDeferredReplace(
      `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=status:asc`
    );

    act(() => {
      rendered.result.current?.setCollapsed("Active", true);
    });
    // An unrelated re-render before the router lands the write: the params
    // still carry the link the hook already consumed.
    rendered.rerender({ groupOptions: [...GROUP_OPTIONS] });
    expect(rendered.result.current?.isCollapsed("Active")).toBe(true);

    flushReplaces(pending);
    expect(rendered.result.current?.isCollapsed("Active")).toBe(true);
    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual(["Active"]);
    expect(pending).toHaveLength(0);
  });
});

/** A router whose replace lands only when the test flushes it, like Next's. */
function renderWithDeferredReplace(href: string) {
  const navigation = createMemoryNavigation({ initialPath: href });
  const pending: (() => void)[] = [];
  const deferredActions: NavigationActions = {
    back: () => undefined,
    forward: () => undefined,
    navigate: (target: string) => navigation.navigate(target),
    refresh: () => undefined,
    replace: (target: string) => {
      pending.push(() => navigation.navigate(target));
    },
  };
  const adapter = {
    ...navigation.adapter,
    useNavigationActions: () => deferredActions,
  };
  const updateView = vi.fn<(patch: SessionsListViewPatch) => void>();
  const view: SessionsListViewState = { ...BASE_VIEW, grouping: BY_STATUS };
  const rendered = renderHook(
    ({ groupOptions }: { groupOptions: readonly TableFieldOption[] }) =>
      useSessionsGroupLink({
        grouping: BY_STATUS,
        groupOptions,
        groups: BANDS,
        updateView,
        view,
      }),
    {
      initialProps: { groupOptions: GROUP_OPTIONS },
      wrapper: ({ children }: { children: ReactNode }) => (
        <NavigationProvider adapter={adapter}>{children}</NavigationProvider>
      ),
    }
  );
  return { navigation, pending, rendered };
}

function flushReplaces(pending: (() => void)[]): void {
  act(() => {
    for (const replace of pending.splice(0)) {
      replace();
    }
  });
}
