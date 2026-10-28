import {
  DOCUMENTS_HIERARCHY_EXPANDED_PARAM,
  useDocumentsHierarchyExpansion,
} from "@repo/app/documents/hooks/use-documents-hierarchy-expansion";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

const BOARD_PATH = "/acme/teams/team-1/projects/project-1";
const STORAGE_KEY = "table:expand:test:hierarchy";

function renderExpansion(href: string | null, linkedExpansionEnabled = true) {
  const navigation: MemoryNavigation | null = href
    ? createMemoryNavigation({ initialPath: href })
    : null;
  const wrapper = navigation
    ? ({ children }: { children: ReactNode }) => (
        <NavigationProvider adapter={navigation.adapter}>
          {children}
        </NavigationProvider>
      )
    : undefined;
  const rendered = renderHook(
    () => {
      const expansion = useDocumentsHierarchyExpansion(
        STORAGE_KEY,
        linkedExpansionEnabled
      );
      const actions = navigation?.adapter.useNavigationActions();
      return { actions, expansion };
    },
    { wrapper }
  );
  return { navigation, rendered };
}

function currentParams(navigation: MemoryNavigation | null): URLSearchParams {
  return new URL(navigation?.getCurrentHref() ?? "", "http://localhost")
    .searchParams;
}

describe("useDocumentsHierarchyExpansion", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps a 500-artifact link under 8 KB and restores all 500 from storage", () => {
    const ids = Array.from(
      { length: 500 },
      (_, index) =>
        `01a1${index.toString(16).padStart(4, "0")}-0000-7000-8000-000000000000`
    );
    const { navigation, rendered } = renderExpansion(BOARD_PATH);

    act(() => {
      rendered.result.current.expansion.setExpandedIds(new Set(ids));
    });

    const href = navigation?.getCurrentHref() ?? "";
    const query = new URL(href, "http://localhost").search;
    expect(query.length).toBeLessThan(8192);
    const linked = currentParams(navigation).getAll(
      DOCUMENTS_HIERARCHY_EXPANDED_PARAM
    );
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.length).toBeLessThan(ids.length);

    const reloaded = renderExpansion(href);
    expect(
      ids.every((id) =>
        reloaded.rendered.result.current.expansion.isExpanded(id)
      )
    ).toBe(true);
    expect(reloaded.rendered.result.current.expansion.expandedSet.size).toBe(
      ids.length
    );
  });

  it("opens only the linked subset when the link came from another reader", () => {
    const { rendered } = renderExpansion(
      `${BOARD_PATH}?${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=shared-a`
    );
    expect(rendered.result.current.expansion.isExpanded("shared-a")).toBe(true);
    expect(rendered.result.current.expansion.expandedSet.size).toBe(1);
  });

  it("restores a linked expansion set over stored state without writing it", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ toggledKeys: ["stored"], version: 1 })
    );
    const { rendered } = renderExpansion(
      `${BOARD_PATH}?${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=linked`
    );

    expect(rendered.result.current.expansion.isExpanded("linked")).toBe(true);
    expect(rendered.result.current.expansion.isExpanded("stored")).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      toggledKeys: ["stored"],
      version: 1,
    });
  });

  it("links and stores the complete resulting expansion set on a gesture", () => {
    const { navigation, rendered } = renderExpansion(
      `${BOARD_PATH}?tab=all&${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=parent-a`
    );

    act(() => {
      rendered.result.current.expansion.toggleGroup("parent-b");
    });

    expect(
      currentParams(navigation).getAll(DOCUMENTS_HIERARCHY_EXPANDED_PARAM)
    ).toEqual(["parent-a", "parent-b"]);
    expect(currentParams(navigation).get("tab")).toBe("all");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      toggledKeys: ["parent-a", "parent-b"],
      version: 1,
    });
  });

  it("keeps an explicit empty linked set authoritative", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ toggledKeys: ["stored"], version: 1 })
    );
    const { rendered } = renderExpansion(
      `${BOARD_PATH}?${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=`
    );

    expect(rendered.result.current.expansion.isExpanded("stored")).toBe(false);
  });

  it("follows a second deep link and browser history without remounting", () => {
    const { navigation, rendered } = renderExpansion(
      `${BOARD_PATH}?${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=first`
    );

    act(() => {
      navigation?.navigate(
        `${BOARD_PATH}?${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=second`
      );
    });
    expect(rendered.result.current.expansion.isExpanded("second")).toBe(true);
    expect(rendered.result.current.expansion.isExpanded("first")).toBe(false);

    act(() => {
      rendered.result.current.actions?.back();
    });
    expect(rendered.result.current.expansion.isExpanded("first")).toBe(true);
    expect(rendered.result.current.expansion.isExpanded("second")).toBe(false);
  });

  it("drops malformed link values and bounds the linked set", () => {
    const params = new URLSearchParams();
    params.append(DOCUMENTS_HIERARCHY_EXPANDED_PARAM, "");
    params.append(DOCUMENTS_HIERARCHY_EXPANDED_PARAM, "x".repeat(257));
    for (let index = 0; index < 502; index += 1) {
      params.append(DOCUMENTS_HIERARCHY_EXPANDED_PARAM, `node-${index}`);
    }
    const { rendered } = renderExpansion(`${BOARD_PATH}?${params}`);

    expect(rendered.result.current.expansion.isExpanded("node-0")).toBe(false);
    expect(rendered.result.current.expansion.isExpanded("node-1")).toBe(false);
    expect(rendered.result.current.expansion.isExpanded("node-2")).toBe(true);
    expect(rendered.result.current.expansion.isExpanded("node-501")).toBe(true);
  });

  it("prunes deleted or inaccessible ids from linked and persisted state", () => {
    const { navigation, rendered } = renderExpansion(
      `${BOARD_PATH}?${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=kept&${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=removed`
    );

    act(() => {
      rendered.result.current.expansion.pruneGroups(new Set(["kept"]));
    });

    expect(
      currentParams(navigation).getAll(DOCUMENTS_HIERARCHY_EXPANDED_PARAM)
    ).toEqual(["kept"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      toggledKeys: ["kept"],
      version: 1,
    });
  });

  it("preserves local expansion and URL history when hierarchy is unavailable", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ toggledKeys: ["stored"], version: 1 })
    );
    const { navigation, rendered } = renderExpansion(
      `${BOARD_PATH}?${DOCUMENTS_HIERARCHY_EXPANDED_PARAM}=linked`,
      false
    );

    expect(rendered.result.current.expansion.isExpanded("stored")).toBe(true);
    expect(rendered.result.current.expansion.isExpanded("linked")).toBe(false);
    act(() => rendered.result.current.expansion.toggleGroup("local"));
    expect(
      currentParams(navigation).getAll(DOCUMENTS_HIERARCHY_EXPANDED_PARAM)
    ).toEqual(["linked"]);
    expect(rendered.result.current.expansion.isExpanded("local")).toBe(true);
  });
});
