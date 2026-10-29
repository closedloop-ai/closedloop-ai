import { useSessionsListView } from "@repo/app/agents/components/sessions/sessions-list-view-state";
import { useSessionsGroupLink } from "@repo/app/agents/hooks/use-sessions-group-link";
import { useSessionsHostControlledView } from "@repo/app/agents/hooks/use-sessions-host-controlled-view";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SessionSortDir } from "@repo/app/agents/lib/session-sort-group";
import { applySessionsHostViewChange } from "@repo/app/agents/lib/sessions-host-view-change";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import {
  SESSIONS_HOST_GROUP_OPTIONS,
  type SessionsHostViewState,
} from "@repo/app/agents/lib/sessions-list-view-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { TABLE_COLLAPSED_GROUP_PARAM } from "@repo/app/shared/lib/table-collapsed-groups";
import { TABLE_GROUP_PARAM } from "@repo/app/shared/lib/table-group-view-params";
import {
  EMPTY_TABLE_GROUPING,
  type TableFieldOption,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, useCallback, useState } from "react";
import { describe, expect, it } from "vitest";

/**
 * The Sessions link hook driven through the REAL controlled host path both
 * shells mount: `useSessionsHostControlledView` composed with the shared
 * `applySessionsHostViewChange` router, feeding `useSessionsListView`. The host
 * keeps only `groupBy` in its persisted vocabulary, so this is where a restored
 * grouping can be narrowed on its way back to the surface.
 */

const SESSIONS_PATH = "/acme/sessions";
const CUSTOM_FIELD_ID = "custom-field:severity";
const SURFACE_GROUP_OPTIONS: readonly TableFieldOption[] = [
  ...SESSIONS_HOST_GROUP_OPTIONS,
  { id: CUSTOM_FIELD_ID, label: "Severity" },
];
const HOST_SEED: SessionsHostViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  groupBy: SessionGroupBy.None,
  page: 0,
  scopeUserId: null,
  search: "",
  secondarySorts: [],
  sortDir: SessionSortDir.Desc,
  sortKey: null,
  visibleColumns: new Set([SessionGroupBy.Status]),
};
const BY_OWNER: TableGroupingState = {
  ...EMPTY_TABLE_GROUPING,
  primary: {
    fieldId: SessionGroupBy.Owner,
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};
const BANDS: GridTableV2Group<SessionTableRow>[] = [
  { items: [], key: "Active", label: "Active" },
  { items: [], key: "Done", label: "Done" },
];

function renderThroughHost(href: string) {
  const navigation = createMemoryNavigation({ initialPath: href });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
  const rendered = renderHook(
    () => {
      const [hostView, setHostView] = useState(HOST_SEED);
      const onHostViewChange = useCallback(
        (next: SessionsHostViewState) => {
          applySessionsHostViewChange(
            next,
            { ...hostView, pageIndex: hostView.page },
            {
              onScopeChange: () => undefined,
              replacePage: (page) =>
                setHostView((current) => ({ ...current, page })),
              setGroupBy: (groupBy) =>
                setHostView((current) => ({ ...current, groupBy })),
              setSecondarySorts: () => undefined,
              setSort: () => undefined,
              toggleColumn: () => undefined,
            }
          );
        },
        [hostView]
      );
      const { controlledView } = useSessionsHostControlledView({
        customFields: undefined,
        hostView,
        listReadState: SessionsListReadState.Settled,
        onHostViewChange,
        total: 0,
      });
      const [view, updateView] = useSessionsListView(controlledView, () => ({
        ...controlledView.value,
      }));
      const port = useSessionsGroupLink({
        grouping: view.grouping,
        groupOptions: SURFACE_GROUP_OPTIONS,
        groups: BANDS,
        updateView,
        view,
      });
      const actions = navigation.adapter.useNavigationActions();
      return {
        actions,
        grouping: view.grouping,
        hostGroupBy: hostView.groupBy,
        port,
        updateView,
      };
    },
    { wrapper }
  );
  return { navigation, rendered };
}

function currentParams(navigation: MemoryNavigation): URLSearchParams {
  return new URL(navigation.getCurrentHref(), "http://localhost").searchParams;
}

describe("useSessionsGroupLink through the controlled Sessions host", () => {
  it("restores a linked grouping the host stores and then honours a collapse click", () => {
    const { navigation, rendered } = renderThroughHost(
      `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=status:asc&${TABLE_COLLAPSED_GROUP_PARAM}=Active`
    );

    expect(rendered.result.current.hostGroupBy).toBe(SessionGroupBy.Status);
    expect(rendered.result.current.grouping.primary.order).toBe(
      TableGroupOrder.Ascending
    );
    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(true);

    act(() => {
      rendered.result.current.port?.setCollapsed("Done", true);
    });

    expect(rendered.result.current.port?.isCollapsed("Done")).toBe(true);
    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual(["Active", "Done"]);
    // The URL names exactly what is rendered.
    expect(currentParams(navigation).getAll(TABLE_GROUP_PARAM)).toEqual([
      `${SessionGroupBy.Status}:${rendered.result.current.grouping.primary.order}`,
    ]);
  });

  it("restores a custom-field grouping the host holds beside its saved view", () => {
    // Spelled the way the codec writes it: the field is encoded inside the value.
    const link = new URLSearchParams([
      [TABLE_GROUP_PARAM, `${encodeURIComponent(CUSTOM_FIELD_ID)}:asc`],
      [TABLE_COLLAPSED_GROUP_PARAM, "Active"],
    ]);
    const { navigation, rendered } = renderThroughHost(
      `${SESSIONS_PATH}?${link}`
    );

    // The saved view cannot name a custom field, so the host stores None and
    // keeps the custom level in its local half, which is what renders.
    expect(rendered.result.current.hostGroupBy).toBe(SessionGroupBy.None);
    expect(rendered.result.current.grouping.primary.fieldId).toBe(
      CUSTOM_FIELD_ID
    );
    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(true);

    act(() => {
      rendered.result.current.port?.setCollapsed("Done", true);
    });

    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual(["Active", "Done"]);
  });

  it("restores a two-level link the host splits across its two stores", () => {
    // The saved view keeps the first level; the second level and its order
    // live in the host's local half.
    const link = new URLSearchParams([
      [TABLE_GROUP_PARAM, "status:asc"],
      [TABLE_GROUP_PARAM, "owner:desc"],
    ]);
    const { navigation, rendered } = renderThroughHost(
      `${SESSIONS_PATH}?${link}`
    );

    expect(rendered.result.current.hostGroupBy).toBe(SessionGroupBy.Status);
    expect(rendered.result.current.grouping.secondary).toEqual({
      fieldId: SessionGroupBy.Owner,
      order: TableGroupOrder.Descending,
      showEmptyGroups: false,
    });

    act(() => {
      rendered.result.current.port?.setCollapsed("Active", true);
    });

    expect(currentParams(navigation).getAll(TABLE_GROUP_PARAM)).toEqual([
      "status:asc",
      "owner:desc",
    ]);
    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual(["Active"]);
  });

  it("follows a second link to the same route instead of overwriting it", () => {
    const { navigation, rendered } = renderThroughHost(
      `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=status:asc&${TABLE_COLLAPSED_GROUP_PARAM}=Active`
    );

    act(() => {
      navigation.navigate(`${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=owner:asc`);
    });

    expect(rendered.result.current.hostGroupBy).toBe(SessionGroupBy.Owner);
    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(false);
    expect(currentParams(navigation).getAll(TABLE_GROUP_PARAM)).toEqual([
      "owner:asc",
    ]);
    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual([]);
  });

  it("restores the earlier grouping on Back instead of replacing it", () => {
    const { navigation, rendered } = renderThroughHost(
      `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=status:asc&${TABLE_COLLAPSED_GROUP_PARAM}=Active`
    );

    // A sidebar search pushes a new entry that carries the link along.
    act(() => {
      navigation.navigate(
        `${SESSIONS_PATH}?${TABLE_GROUP_PARAM}=status:asc&${TABLE_COLLAPSED_GROUP_PARAM}=Active&search=build`
      );
    });
    // The reader switches to Owner on that entry, which the hook writes.
    act(() => {
      rendered.result.current.updateView({ grouping: BY_OWNER });
    });
    expect(rendered.result.current.hostGroupBy).toBe(SessionGroupBy.Owner);
    expect(currentParams(navigation).getAll(TABLE_GROUP_PARAM)).toEqual([
      "owner:asc",
    ]);

    act(() => {
      rendered.result.current.actions.back();
    });

    expect(rendered.result.current.hostGroupBy).toBe(SessionGroupBy.Status);
    expect(rendered.result.current.grouping.primary.order).toBe(
      TableGroupOrder.Ascending
    );
    expect(rendered.result.current.port?.isCollapsed("Active")).toBe(true);
    expect(currentParams(navigation).getAll(TABLE_GROUP_PARAM)).toEqual([
      "status:asc",
    ]);
  });
});
