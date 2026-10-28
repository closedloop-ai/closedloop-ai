import { useDocumentsGroupLink } from "@repo/app/documents/hooks/use-documents-group-link";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { groupExpansionKey } from "@repo/app/shared/hooks/use-group-expansion";
import { TABLE_COLLAPSED_GROUP_PARAM } from "@repo/app/shared/lib/table-collapsed-groups";
import { TABLE_GROUP_PARAM } from "@repo/app/shared/lib/table-group-view-params";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * PRD-720 AC3 on the project board: grouping and closed bands ride the link,
 * over the reader's stored view, and a gesture stores and links what is shown.
 */

const BOARD_PATH = "/acme/teams/t1/projects/p1";
const GROUP_BY_KEY = "test:documents-group-by";
const EXPANSION_BASE = "test:board";
const COLLAPSED_KEY = groupExpansionKey(EXPANSION_BASE, "-collapsed-groups");
const STATUS_AXIS = `${GroupByMode.Status}|`;
const PRIORITY_AXIS = `${GroupByMode.Priority}|`;
const ASSIGNEE_AXIS = `${GroupByMode.Assignee}|`;
/** The flat record the board kept before collapse was per axis. */
const LEGACY_SECTIONS_KEY = groupExpansionKey(
  EXPANSION_BASE,
  "-group-sections"
);

function renderBoardLink(href: string | null) {
  const navigation: MemoryNavigation | null =
    href === null ? null : createMemoryNavigation({ initialPath: href });
  const wrapper = navigation
    ? ({ children }: { children: ReactNode }) => (
        <NavigationProvider adapter={navigation.adapter}>
          {children}
        </NavigationProvider>
      )
    : undefined;
  const rendered = renderHook(
    () => {
      const link = useDocumentsGroupLink({
        expansionStorageKey: EXPANSION_BASE,
        groupByStorageKey: GROUP_BY_KEY,
      });
      const actions = navigation?.adapter.useNavigationActions();
      return { actions, link };
    },
    { wrapper }
  );
  return { navigation, rendered };
}

function currentParams(navigation: MemoryNavigation | null): URLSearchParams {
  return new URL(navigation?.getCurrentHref() ?? "", "http://localhost")
    .searchParams;
}

function stored(key: string | null): unknown {
  const raw = key === null ? null : localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

describe("useDocumentsGroupLink", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows the reader's stored view when the link names no grouping", () => {
    localStorage.setItem(GROUP_BY_KEY, JSON.stringify(GroupByMode.Priority));
    localStorage.setItem(
      COLLAPSED_KEY ?? "",
      JSON.stringify({ [PRIORITY_AXIS]: ["high"] })
    );

    const { navigation, rendered } = renderBoardLink(`${BOARD_PATH}?tab=all`);

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Priority);
    expect(rendered.result.current.link.collapsedGroups).toEqual({
      [PRIORITY_AXIS]: ["high"],
    });
    // Reading is not writing: the URL is left as it was opened.
    expect(navigation?.getHistory()).toHaveLength(1);
  });

  it("keeps the bands closed in the old flat record when no per-axis record exists yet", () => {
    localStorage.setItem(GROUP_BY_KEY, JSON.stringify(GroupByMode.Status));
    localStorage.setItem(LEGACY_SECTIONS_KEY ?? "", JSON.stringify(["done"]));

    const { rendered } = renderBoardLink(BOARD_PATH);

    // The flat record closed a key under whatever grouping was shown, so it
    // carries to every axis.
    expect(rendered.result.current.link.collapsedGroups).toEqual({
      [ASSIGNEE_AXIS]: ["done"],
      [PRIORITY_AXIS]: ["done"],
      [STATUS_AXIS]: ["done"],
    });
  });

  it("prefers the per-axis record over the old flat one once it exists", () => {
    localStorage.setItem(LEGACY_SECTIONS_KEY ?? "", JSON.stringify(["done"]));
    localStorage.setItem(
      COLLAPSED_KEY ?? "",
      JSON.stringify({ [STATUS_AXIS]: ["draft"] })
    );

    const { rendered } = renderBoardLink(BOARD_PATH);

    expect(rendered.result.current.link.collapsedGroups).toEqual({
      [STATUS_AXIS]: ["draft"],
    });
  });

  it("writes the carried record forward on the first gesture", () => {
    localStorage.setItem(GROUP_BY_KEY, JSON.stringify(GroupByMode.Status));
    localStorage.setItem(LEGACY_SECTIONS_KEY ?? "", JSON.stringify(["done"]));
    const { rendered } = renderBoardLink(BOARD_PATH);

    act(() => {
      rendered.result.current.link.setGroupBy(GroupByMode.Priority);
    });

    expect(stored(COLLAPSED_KEY)).toEqual({
      [ASSIGNEE_AXIS]: ["done"],
      [PRIORITY_AXIS]: ["done"],
      [STATUS_AXIS]: ["done"],
    });
  });

  it("restores a linked grouping and closed band over the recipient's stored view, without storing it", () => {
    localStorage.setItem(GROUP_BY_KEY, JSON.stringify(GroupByMode.Priority));

    const { rendered } = renderBoardLink(
      `${BOARD_PATH}?${TABLE_GROUP_PARAM}=status:custom&${TABLE_COLLAPSED_GROUP_PARAM}=done`
    );

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Status);
    expect(rendered.result.current.link.collapsedGroups).toEqual({
      [STATUS_AXIS]: ["done"],
    });
    expect(stored(GROUP_BY_KEY)).toBe(GroupByMode.Priority);
  });

  it("still opens a link that names the grouping without an order", () => {
    const { rendered } = renderBoardLink(
      `${BOARD_PATH}?${TABLE_GROUP_PARAM}=${GroupByMode.Assignee}`
    );

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Assignee);
  });

  it.each([
    ["an unknown field", "bogus:custom"],
    ["a second level this list cannot render", "status:custom&group=priority"],
  ])("ignores a link naming %s and keeps the stored view", (_case, level) => {
    localStorage.setItem(GROUP_BY_KEY, JSON.stringify(GroupByMode.Priority));

    const { rendered } = renderBoardLink(
      `${BOARD_PATH}?${TABLE_GROUP_PARAM}=${level}&${TABLE_COLLAPSED_GROUP_PARAM}=done`
    );

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Priority);
    expect(rendered.result.current.link.collapsedGroups).toEqual({});
  });

  it("links and stores a closed band, keeping unrelated parameters", () => {
    const { navigation, rendered } = renderBoardLink(
      `${BOARD_PATH}?tab=all&${TABLE_GROUP_PARAM}=status:custom`
    );

    act(() => {
      rendered.result.current.link.setCollapsedGroups({
        [STATUS_AXIS]: ["done"],
      });
    });

    const params = currentParams(navigation);
    expect(params.get("tab")).toBe("all");
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual(["status:custom"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["done"]);
    expect(stored(GROUP_BY_KEY)).toBe(GroupByMode.Status);
    expect(stored(COLLAPSED_KEY)).toEqual({ [STATUS_AXIS]: ["done"] });
    expect(rendered.result.current.link.collapsedGroups).toEqual({
      [STATUS_AXIS]: ["done"],
    });
  });

  it("keeps a band closed under one grouping while another is shown", () => {
    const { navigation, rendered } = renderBoardLink(
      `${BOARD_PATH}?${TABLE_GROUP_PARAM}=status:custom&${TABLE_COLLAPSED_GROUP_PARAM}=done`
    );

    act(() => {
      rendered.result.current.link.setGroupBy(GroupByMode.Priority);
    });

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Priority);
    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual([]);

    act(() => {
      rendered.result.current.link.setGroupBy(GroupByMode.Status);
    });

    expect(rendered.result.current.link.collapsedGroups[STATUS_AXIS]).toEqual([
      "done",
    ]);
    expect(
      currentParams(navigation).getAll(TABLE_COLLAPSED_GROUP_PARAM)
    ).toEqual(["done"]);
  });

  it("removes the grouping from the link when the reader ungroups", () => {
    const { navigation, rendered } = renderBoardLink(
      `${BOARD_PATH}?${TABLE_GROUP_PARAM}=status:custom&${TABLE_COLLAPSED_GROUP_PARAM}=done`
    );

    act(() => {
      rendered.result.current.link.setGroupBy(GroupByMode.None);
    });

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.None);
    expect(currentParams(navigation).has(TABLE_GROUP_PARAM)).toBe(false);
    expect(currentParams(navigation).has(TABLE_COLLAPSED_GROUP_PARAM)).toBe(
      false
    );
  });

  it("follows a second link to the board and Back without a remount", () => {
    const { navigation, rendered } = renderBoardLink(
      `${BOARD_PATH}?${TABLE_GROUP_PARAM}=status:custom&${TABLE_COLLAPSED_GROUP_PARAM}=done`
    );

    act(() => {
      navigation?.navigate(
        `${BOARD_PATH}?${TABLE_GROUP_PARAM}=assignee:custom`
      );
    });

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Assignee);

    act(() => {
      rendered.result.current.actions?.back();
    });

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Status);
    expect(rendered.result.current.link.collapsedGroups).toEqual({
      [STATUS_AXIS]: ["done"],
    });
  });

  it("stores gestures and writes no link when no navigation provider is mounted", () => {
    const { rendered } = renderBoardLink(null);

    act(() => {
      rendered.result.current.link.setGroupBy(GroupByMode.Status);
    });
    act(() => {
      rendered.result.current.link.setCollapsedGroups({
        [STATUS_AXIS]: ["done"],
      });
    });

    expect(rendered.result.current.link.groupBy).toBe(GroupByMode.Status);
    expect(rendered.result.current.link.collapsedGroups).toEqual({
      [STATUS_AXIS]: ["done"],
    });
  });
});
