import { useDocumentsGroupLink } from "@repo/app/documents/hooks/use-documents-group-link";
import { useArtifactHierarchyExpansion } from "@repo/app/shared/hooks/use-artifact-hierarchy-expansion";
import { HIERARCHY_EXPANDED_PARAM } from "@repo/app/shared/lib/hierarchy-expanded-param";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { createLaggingNavigation } from "../../test-fixtures/lagging-navigation";

const PATH = "/teams/team-1/projects/project-1";
const FILTER_QUERY = "owners=ada&statuses=todo";

function mountWriters(initialQuery: string) {
  const navigation = createLaggingNavigation(`${PATH}?${initialQuery}`);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
  const rendered = renderHook(
    () => ({
      expansion: useArtifactHierarchyExpansion("test:expansion", true),
      group: useDocumentsGroupLink({
        expansionStorageKey: "test:group",
        groupByStorageKey: "test:group-by",
      }),
    }),
    { wrapper }
  );
  return { navigation, rendered };
}

function paramsOf(href: string | undefined): URLSearchParams {
  return new URL(href ?? "", "http://localhost").searchParams;
}

describe("linked URL writers on one route", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("AC-3: A guard test proves two writers in one render cycle never drop each other's params (expansion after grouping)", () => {
    const { navigation, rendered } = mountWriters(FILTER_QUERY);

    act(() => {
      rendered.result.current.group.setGroupBy("priority");
      rendered.result.current.expansion.setExpandedIds(new Set(["parent-a"]));
    });

    const last = paramsOf(navigation.replacedHrefs.at(-1));
    expect(last.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual(["parent-a"]);
    expect(last.get("group")).toBe("priority:custom");
    expect(last.get("owners")).toBe("ada");
    expect(last.get("statuses")).toBe("todo");
  });

  it("AC-3: A guard test proves two writers in one render cycle never drop each other's params (grouping after expansion)", () => {
    const { navigation, rendered } = mountWriters(FILTER_QUERY);

    act(() => {
      rendered.result.current.expansion.setExpandedIds(new Set(["parent-a"]));
      rendered.result.current.group.setGroupBy("priority");
    });

    const last = paramsOf(navigation.replacedHrefs.at(-1));
    expect(last.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual(["parent-a"]);
    expect(last.get("group")).toBe("priority:custom");
    expect(last.get("owners")).toBe("ada");
  });

  it("AC-2: URL writers merge onto the current URL so neither drops the other's params, whether the router reflected the earlier write or not", () => {
    const { navigation, rendered } = mountWriters(FILTER_QUERY);

    act(() => {
      rendered.result.current.expansion.setExpandedIds(new Set(["parent-a"]));
    });
    act(() => {
      navigation.landReplaces();
    });
    act(() => {
      rendered.result.current.group.setGroupBy("priority");
    });
    act(() => {
      rendered.result.current.expansion.setExpandedIds(
        new Set(["parent-a", "parent-b"])
      );
    });

    const last = paramsOf(navigation.replacedHrefs.at(-1));
    expect(last.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual([
      "parent-a",
      "parent-b",
    ]);
    expect(last.get("group")).toBe("priority:custom");
    expect(last.get("owners")).toBe("ada");
  });

  it("AC-4: Link-restorable hierarchy expansion from ISS-12929 keeps working beside the other writers", () => {
    const { navigation, rendered } = mountWriters(FILTER_QUERY);
    act(() => {
      rendered.result.current.group.setGroupBy("priority");
      rendered.result.current.expansion.setExpandedIds(new Set(["parent-a"]));
    });
    act(() => navigation.landReplaces());

    const reopened = createLaggingNavigation(navigation.getCurrentHref());
    const restored = renderHook(
      () => useArtifactHierarchyExpansion("test:reopened", true),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <NavigationProvider adapter={reopened.adapter}>
            {children}
          </NavigationProvider>
        ),
      }
    );

    expect(restored.result.current.isExpanded("parent-a")).toBe(true);
    expect(restored.result.current.expandedSet.size).toBe(1);
  });
});
