import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
} from "../../../shared/components/generic-artifact-surface/generic-artifact-status";
import { useGenericArtifactListController } from "../../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-controller";
import type { GenericArtifact } from "../../../shared/components/generic-artifact-surface/preview/fixtures";

const root: GenericArtifact = {
  id: "root",
  slug: "PRD-1",
  title: "Parent",
  summary: "",
  kind: GenericArtifactKind.Document,
  status: GenericArtifactStatus.Draft,
  owner: "",
  ownerInitials: "",
  collaborators: [],
  repository: null,
  project: "Project",
  tags: [],
  currentVersion: "1",
  updated: "now",
  updatedAgoMinutes: 0,
  createdAgoDays: 0,
  aiSpend: 0,
  timeToReadyMinutes: 0,
  outcomeScore: 0,
  activityCount: 0,
  relationshipCount: 0,
};
const child: GenericArtifact = {
  ...root,
  id: "child",
  slug: "ISS-1",
  title: "Matching child",
  kind: GenericArtifactKind.Issue,
  parentArtifactId: root.id,
};
const onOpenArtifact = vi.fn();

beforeEach(() => globalThis.localStorage.clear());
describe("Project artifact shared route and hierarchy state", () => {
  it("restores adapter queries and removes stale date-range state without touching the shell URL directly", async () => {
    const replace = vi.fn();
    const { result, rerender } = renderHook(
      ({ search }) =>
        useGenericArtifactListController({
          artifacts: [root, child],
          controlledArtifacts: true,
          currentUser: { id: "user", name: "User" },
          onOpenArtifact,
          routeState: { search, replace },
          hasDateDimension: false,
          defaultGroupBy: "status",
          defaultVisibleColumnIds: ["owner", "status"],
          boardRootOnly: true,
          hierarchy: { maxVisibleLevels: 4 },
        }),
      {
        initialProps: {
          search: "columns=owner%2Cstatus&group=none&layout=board&range=7d",
        },
      }
    );
    await waitFor(() => expect(result.current.layout).toBe("board"));
    expect(result.current.groupBy).toBe("none");
    expect([...result.current.visibleColumnIds]).toEqual(["owner", "status"]);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(
      new URLSearchParams(replace.mock.calls.at(-1)?.[0]).has("range")
    ).toBe(false);
    rerender({ search: "columns=status&group=status&layout=list" });
    await waitFor(() => expect(result.current.layout).toBe("list"));
    expect([...result.current.visibleColumnIds]).toEqual(["status"]);
  });
  it("never replaces the URL with the previous params after an outside navigation changes an owned param", async () => {
    const replace = vi.fn();
    const { result, rerender } = renderHook(
      ({ search }) =>
        useGenericArtifactListController({
          artifacts: [root, child],
          controlledArtifacts: true,
          currentUser: { id: "user", name: "User" },
          onOpenArtifact,
          routeState: { search, replace },
          hasDateDimension: false,
          defaultGroupBy: "status",
          defaultVisibleColumnIds: ["owner", "status"],
          boardRootOnly: true,
          hierarchy: { maxVisibleLevels: 4 },
        }),
      { initialProps: { search: "layout=board&group=status" } }
    );
    await waitFor(() => expect(result.current.layout).toBe("board"));
    replace.mockClear();

    rerender({ search: "layout=list&group=status" });
    await waitFor(() => expect(result.current.layout).toBe("list"));

    for (const [query] of replace.mock.calls) {
      expect(new URLSearchParams(query).get("layout")).not.toBe("board");
    }
  });
  it("keeps a matching descendant's ancestor and restores explicit collapse across remounts", async () => {
    const options = {
      artifacts: [root, child],
      controlledArtifacts: true,
      onOpenArtifact,
      currentUser: { id: "user", name: "User" },
      hasDateDimension: false,
      boardRootOnly: true,
      hierarchy: {
        maxVisibleLevels: 4,
        expansionStorageKey: "project-test:expansion",
      },
    };
    const first = renderHook(
      ({ textFilter }) =>
        useGenericArtifactListController({ ...options, textFilter }),
      { initialProps: { textFilter: "" } }
    );
    await waitFor(() =>
      expect(first.result.current.hierarchyView.isExpanded(root.id)).toBe(true)
    );
    act(() => first.result.current.hierarchyView.toggleExpanded(root.id));
    expect(first.result.current.hierarchyView.isExpanded(root.id)).toBe(false);
    first.rerender({ textFilter: "Matching child" });
    await waitFor(() =>
      expect(
        first.result.current.hierarchyView.orderedArtifacts.map((row) => row.id)
      ).toEqual(["root", "child"])
    );
    expect(first.result.current.matchingArtifacts.map((row) => row.id)).toEqual(
      ["child"]
    );
    first.rerender({ textFilter: "" });
    await waitFor(() =>
      expect(first.result.current.hierarchyView.isExpanded(root.id)).toBe(false)
    );
    first.unmount();
    const second = renderHook(() => useGenericArtifactListController(options));
    expect(second.result.current.hierarchyView.isExpanded(root.id)).toBe(false);
  });
  it("keeps each subtree under its root's secondary grouping field", async () => {
    const parent = { ...root, owner: "Ada", ownerId: "ada" };
    const descendant = { ...child, owner: "Grace", ownerId: "grace" };
    const { result } = renderHook(() =>
      useGenericArtifactListController({
        artifacts: [parent, descendant],
        controlledArtifacts: true,
        onOpenArtifact,
        routeState: { search: "group=status&subgroup=owner", replace: vi.fn() },
        boardRootOnly: true,
        hierarchy: { maxVisibleLevels: 4 },
      })
    );
    await waitFor(() => expect(result.current.secondaryGroupBy).toBe("owner"));
    const group = result.current.groupedArtifacts?.find((item) =>
      item.items.some((row) => row.id === root.id)
    );
    const subgroup = group?.subgroups?.find((item) =>
      item.items.some((row) => row.id === root.id)
    );
    expect(subgroup?.items.map((row) => row.id)).toEqual([root.id, child.id]);
    expect(
      group?.subgroups?.some(
        (item) =>
          item.items.some((row) => row.id === child.id) &&
          item.key !== subgroup?.key
      )
    ).toBe(false);
  });
});
