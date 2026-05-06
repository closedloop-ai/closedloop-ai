import { DocumentType } from "@repo/api/src/types/document";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
}));

vi.mock("@/hooks/queries/use-judges", () => ({
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useFeatureJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

import { createMockDocument } from "@/__tests__/fixtures/documents";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import type { DisplayGroup } from "@/components/document-table/document-tree";
import { DocumentColumn as Col } from "@/hooks/use-column-visibility";
import { TreeGroupRows } from "../tree-group-rows";

function makeRootItem(id: string): DocumentRowItem {
  return {
    kind: "artifact",
    data: createMockDocument({ id, slug: id, title: `Root ${id}` }),
  };
}

function makeChildItem(id: string): DocumentRowItem {
  return {
    kind: "artifact",
    data: createMockDocument({
      id,
      slug: id,
      title: `Child ${id}`,
      type: DocumentType.ImplementationPlan,
    }),
  };
}

function renderTreeGroup(
  group: DisplayGroup,
  options: {
    isGroupExpanded?: (key: string) => boolean;
    toggleGroup?: (key: string) => void;
  } = {}
) {
  const isGroupExpanded = options.isGroupExpanded ?? (() => false);
  const toggleGroup = options.toggleGroup ?? vi.fn();
  const result = render(
    <TreeGroupRows
      group={group}
      isGroupExpanded={isGroupExpanded}
      parentMap={new Map()}
      toggleGroup={toggleGroup}
      visibleColumns={[Col.Type]}
    />
  );
  return { ...result, toggleGroup };
}

function findChevronButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  ).filter((btn) => btn.querySelector("svg.lucide-chevron-right") !== null);
}

describe("TreeGroupRows — root row chevron rendering", () => {
  it("renders an enabled chevron on the root when the group has children", () => {
    // Regression guard: previously the chevron's render condition was based on
    // `root.children?.length`, but `groupByProjectTree` never sets `.children`
    // on the root DocumentRowItem (children live on `group.children`). That
    // hid the chevron and left users with no way to expand subtrees.
    const root = makeRootItem("root-1");
    const child = makeChildItem("child-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [child],
    };

    const { container } = renderTreeGroup(group);

    const chevrons = findChevronButtons(container);
    expect(chevrons).toHaveLength(1);

    const rootChevron = chevrons[0];
    expect(rootChevron).toBeEnabled();
    expect(rootChevron.className).toContain("hover:bg-muted");
    expect(rootChevron.className).not.toContain("cursor-default");
  });

  it("invokes toggleGroup with the group key when the root chevron is clicked", () => {
    const root = makeRootItem("root-1");
    const child = makeChildItem("child-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [child],
    };
    const toggleGroup = vi.fn();

    const { container } = renderTreeGroup(group, { toggleGroup });

    const [rootChevron] = findChevronButtons(container);
    fireEvent.click(rootChevron);

    expect(toggleGroup).toHaveBeenCalledTimes(1);
    expect(toggleGroup).toHaveBeenCalledWith(group.groupKey);
  });

  it("rotates the root chevron when the group is expanded", () => {
    const root = makeRootItem("root-1");
    const child = makeChildItem("child-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [child],
    };

    const { container } = renderTreeGroup(group, {
      isGroupExpanded: (key) => key === group.groupKey,
    });

    const [rootChevron] = findChevronButtons(container);
    const icon = rootChevron.querySelector("svg.lucide-chevron-right");
    expect(icon?.getAttribute("class") ?? "").toContain("rotate-90");
  });

  it("renders no chevron on the root when the group has no children", () => {
    const root = makeRootItem("root-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [],
    };

    const { container } = renderTreeGroup(group);

    expect(findChevronButtons(container)).toHaveLength(0);
  });

  it("renders the root chevron regardless of `root.children` (driven by group.children)", () => {
    // toRowItem() never attaches `.children` to a root; this asserts the
    // component derives expandability from group.children, not item.children.
    const root = makeRootItem("root-1");
    expect(
      (root as DocumentRowItem & { children?: DocumentRowItem[] }).children
    ).toBeUndefined();

    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [makeChildItem("child-1")],
    };

    const { container } = renderTreeGroup(group);
    expect(findChevronButtons(container)).toHaveLength(1);
  });
});
