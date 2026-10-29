import { useDocumentsGroupLink } from "@repo/app/documents/hooks/use-documents-group-link";
import { useArtifactHierarchyExpansion } from "@repo/app/shared/hooks/use-artifact-hierarchy-expansion";
import { HIERARCHY_EXPANDED_PARAM } from "@repo/app/shared/lib/hierarchy-expanded-param";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { createDesktopNavigation } from "../desktop-adapter";

const START = "/teams/team-1/projects/project-1?owners=ada&statuses=todo";

describe("linked URL writers on the real Desktop navigation adapter", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("AC-3: A guard test proves two writers in one render cycle never drop each other's params, through the window hash host that pushes history", () => {
    globalThis.location.hash = START;
    const navigation = createDesktopNavigation();
    const { result } = renderHook(
      () => ({
        expansion: useArtifactHierarchyExpansion("desktop:expansion", true),
        group: useDocumentsGroupLink({
          expansionStorageKey: "desktop:group",
          groupByStorageKey: "desktop:group-by",
        }),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <NavigationProvider adapter={navigation.adapter}>
            {children}
          </NavigationProvider>
        ),
      }
    );

    act(() => {
      result.current.group.setGroupBy("priority");
      result.current.expansion.setExpandedIds(new Set(["parent-a"]));
    });

    const params = new URL(navigation.getHref(), "http://localhost")
      .searchParams;
    expect(params.get("owners")).toBe("ada");
    expect(params.get("statuses")).toBe("todo");
    expect(params.get("group")).toBe("priority:custom");
    expect(params.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual(["parent-a"]);
    navigation.dispose();
  });
});
