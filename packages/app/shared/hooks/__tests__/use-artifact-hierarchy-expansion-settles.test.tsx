import { useArtifactHierarchyExpansion } from "@repo/app/shared/hooks/use-artifact-hierarchy-expansion";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { createLaggingNavigation } from "../../test-fixtures/lagging-navigation";

const PATH = "/teams/team-1/projects/project-1";
const PARENT_ID = "parent-a";

describe("linked hierarchy expansion while the router has not reflected its write", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("AC-4: an owner that keeps the parent open settles after the writes it causes instead of re-committing on every render", () => {
    const navigation = createLaggingNavigation(`${PATH}?statuses=todo`);
    const { result } = renderHook(
      () => {
        const expansion = useArtifactHierarchyExpansion(
          "settles:expansion",
          true
        );
        const { expandedSet, setExpandedIds } = expansion;
        useEffect(() => {
          setExpandedIds(new Set([...expandedSet, PARENT_ID]));
        }, [expandedSet, setExpandedIds]);
        return expansion;
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <NavigationProvider adapter={navigation.adapter}>
            {children}
          </NavigationProvider>
        ),
      }
    );

    act(() => {
      result.current.toggleGroup(PARENT_ID);
    });

    // The owner opens the parent on mount, the collapse writes the empty set,
    // and the owner re-opens it: three writes, then it settles.
    expect(navigation.replacedHrefs).toHaveLength(3);
    expect(result.current.expandedSet.has(PARENT_ID)).toBe(true);
  });
});
